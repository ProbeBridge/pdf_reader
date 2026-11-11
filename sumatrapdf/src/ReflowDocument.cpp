/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/File.h"
#include "base/Win.h"
#include "base/JsonParser.h"
#include "base/UITask.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/win/WebView.h"
#include "Settings.h"
#include "AppSettings.h"
#include "AppTools.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "AIChatTypes.h"
#include "WindowTab.h"
#include "Commands.h"
#include "Canvas.h"
#include "Toolbar.h"
#include "ContextNoteOverlay.h"
#include "ReflowDocument.h"

struct ReflowView : WebviewWnd {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    WindowTab* tab = nullptr;
    EngineBase* engine = nullptr; // AddRef: survives tab closure until view destruction
    u64 epoch = 0;
    bool enabled = false;
    bool ready = false;
    int page = 1;
    int zoom = 100;
    int pendingPages = 0;
    Str documentPath;

    ~ReflowView() override {
        if (engine) engine->Release();
        str::Free(documentPath);
    }
};

static Vec<ReflowView*> gReflowViews;
static u64 gReflowEpoch = 0;

static ReflowView* FindReflow(MainWindow* win) {
    for (auto* view : gReflowViews)
        if (view->win == win) return view;
    return nullptr;
}

static TempStr ReflowQuote(Str value) {
    return fmt("\"%s\"", json::EscapeStrTemp(value));
}

static TempStr ReflowField(Str data, Str key) {
    json::Reader reader(data);
    Str segment = str::JoinTemp(StrL("/"), key);
    for (json::Value& value : reader)
        if (json::PathMatch(value.path, segment)) return str::DupTemp(value.value);
    return {};
}

static void ReflowEvent(ReflowView* view, Str event, Str detail) {
    if (view && view->ready)
        view->Eval(fmt("dispatchEvent(new CustomEvent(%s,{detail:%s}))", ReflowQuote(event), detail));
}

bool ReflowDocumentAvailable(MainWindow* win) {
    auto* dm = win ? win->AsFixed() : nullptr;
    auto* engine = dm ? dm->GetEngine() : nullptr;
    return engine && engine->kind == kindEngineMupdf && !engine->isReflowable && !engine->isImageCollection &&
           engine->allowsCopyingText && HasPermission(Perm::CopySelection) && HasWebView();
}

bool ReflowDocumentVisible(MainWindow* win) {
    auto* view = FindReflow(win);
    auto* dm = win ? win->AsFixed() : nullptr;
    return view && view->enabled && view->tab == win->CurrentTab() && dm && view->engine == dm->GetEngine() &&
           !win->InPresentation();
}

int ReflowDocumentZoom(MainWindow* win) {
    auto* view = FindReflow(win);
    return ReflowDocumentVisible(win) ? view->zoom : 0;
}

static void ReflowSetZoom(ReflowView* view, int zoom) {
    view->zoom = limitValue(zoom, 50, 400);
    // Keep the WebView's own page zoom at 100%; only the content's typography
    // changes, so tables/images remain constrained to the available width.
    ReflowEvent(view, StrL("reflowzoom"), fmt("{\"zoom\":%d}", view->zoom));
    ScheduleUiUpdate(view->win, kUiToolbarDirty);
}

bool ReflowDocumentZoomBy(MainWindow* win, float factor) {
    if (!ReflowDocumentVisible(win)) return false;
    ReflowSetZoom(FindReflow(win), (int)(FindReflow(win)->zoom * factor + .5f));
    return true;
}

void ReflowDocumentUpdateNotes(MainWindow* win) {
    if (ReflowDocumentVisible(win)) ReflowEvent(FindReflow(win), StrL("reflowstate"), ContextNotesReflowState(win));
}

bool ReflowDocumentGoToNote(MainWindow* win, Str id) {
    if (!ReflowDocumentVisible(win)) return false;
    ReflowEvent(FindReflow(win), StrL("reflowfocus"), fmt("{\"id\":%s}", ReflowQuote(id)));
    return true;
}

struct ReflowPageTask {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    EngineBase* engine = nullptr;
    u64 epoch = 0;
    int page = 0;
    Str id;
    ReflowPageData data;
};

static void FinishReflowPage(ReflowPageTask* task) {
    ReflowView* view =
        IsMainWindowValid(task->win) && task->win->hwndFrame == task->frame ? FindReflow(task->win) : nullptr;
    if (view && view->epoch == task->epoch) {
        view->pendingPages--;
        if (ReflowDocumentVisible(task->win) && view->engine == task->engine) {
            view->Resolve(task->id, 0,
                          fmt("{\"page\":%d,\"html\":%s,\"sourceText\":%s,\"displayText\":%s,\"error\":%s}", task->page,
                              ReflowQuote(task->data.html), ReflowQuote(task->data.sourceText),
                              ReflowQuote(task->data.displayText), ReflowQuote(task->data.error)));
        } else {
            view->Resolve(task->id, 1, ReflowQuote(StrL("Reflow view is no longer active.")));
        }
    }
    FreeReflowPageData(&task->data);
    str::Free(task->id);
    task->engine->Release();
    delete task;
}

static void LoadReflowPage(ReflowPageTask* task) {
    task->data = task->engine->ExtractReflowPage(task->page);
    task->engine->ReleaseTextExtractionThreadContext();
    uitask::Post(MkFunc0(FinishReflowPage, task), "ReflowPage");
    AtomicIntDec(&gDangerousThreadCount);
}

static TempStr ReflowAssets() {
    WCHAR exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe, dimof(exe));
    Str dir = path::GetDirTemp(ToUtf8Temp(WStr(exe)));
    Str assets = path::JoinTemp(dir, StrL("notes"));
    if (path::IsDirectory(assets)) return str::DupTemp(assets);
    return path::JoinTemp(path::GetDirTemp(path::GetDirTemp(dir)), StrL("src\\notes"));
}

static bool ReflowResource(void*, Str resource, WebViewResourceResult* out) {
    while (len(resource) > 0 && resource.s[0] == '/') resource = Str(resource.s + 1, len(resource) - 1);
    bool html = str::Eq(resource, StrL("reflow.html"));
    bool css = str::Eq(resource, StrL("reflow.css"));
    bool js = str::Eq(resource, StrL("reflow.js")) || str::Eq(resource, StrL("reflow-model.js"));
    if (!html && !css && !js) return false;
    Str bytes = file::ReadFile(path::JoinTemp(ReflowAssets(), resource));
    if (len(bytes) == 0) return false;
    out->data = (const u8*)bytes.s;
    out->dataLen = len(bytes);
    out->contentType = str::Dup(html  ? StrL("text/html; charset=utf-8")
                                : css ? StrL("text/css; charset=utf-8")
                                      : StrL("text/javascript; charset=utf-8"));
    return true;
}

static bool ReflowNavigation(void*, Str url, bool newWindow) {
    return !newWindow && (str::Eq(url, StrL("reflow.html")) || str::Eq(url, StrL("/reflow.html")));
}

static int ReflowAccel(void*, u16 vk, bool ctrl, bool shift, bool alt) {
    if (ctrl && shift && !alt && vk == 'R') return CmdToggleDocumentReflow;
    if (ctrl && shift && !alt && vk == 'A') return CmdContextNotes;
    if (alt && shift && vk == 'A') return CmdContextAnnotate;
    if (ctrl && !alt && (vk == VK_ADD || vk == VK_OEM_PLUS)) return CmdZoomIn;
    if (ctrl && !alt && (vk == VK_SUBTRACT || vk == VK_OEM_MINUS)) return CmdZoomOut;
    if (ctrl && !alt && (vk == '0' || vk == VK_NUMPAD0 || vk == '1' || vk == VK_NUMPAD1)) return CmdZoomActualSize;
    if (ctrl && !alt && vk == 'F') return CmdFindFirst;
    if (ctrl && !alt && vk == 'O') return CmdOpenFile;
    if (ctrl && !alt && vk == 'H') return CmdReadingHistory;
    return 0;
}

static void ReflowCall(void* ctx, Str id, Str method, Str params) {
    auto* view = (ReflowView*)ctx;
    MainWindow* win = view->win;
    if (!str::Eq(method, StrL("reflow")) || !ReflowDocumentVisible(win)) {
        view->Resolve(id, 1, ReflowQuote(StrL("Reflow view is no longer active.")));
        return;
    }
    Str data;
    json::Reader args(params);
    for (json::Value& value : args)
        if (json::PathMatch(value.path, StrL("i0")) && value.type == json::Type::String) data = value.value;
    Str action = ReflowField(data, StrL("action"));
    Str result = StrL("true");
    int error = 0;
    if (str::Eq(action, StrL("ready"))) {
        view->ready = true;
        result = fmt("{\"page\":%d,\"pageCount\":%d,\"zoom\":%d,\"notes\":%s}", view->page, view->engine->PageCount(),
                     view->zoom, ContextNotesReflowState(win));
    } else if (str::Eq(action, StrL("page"))) {
        int page = atoi(CStrTemp(ReflowField(data, StrL("page"))));
        if (page < 1 || page > view->engine->PageCount() || view->pendingPages >= 5) {
            error = 1;
            result = ReflowQuote(StrL("Invalid page or too many pending reflow pages."));
        } else {
            auto* task = new ReflowPageTask();
            task->win = win;
            task->frame = win->hwndFrame;
            task->engine = view->engine;
            task->epoch = view->epoch;
            task->page = page;
            task->id = str::Dup(id);
            task->engine->AddRef();
            view->pendingPages++;
            AtomicIntInc(&gDangerousThreadCount);
            ThreadHandle thread = StartThread(MkFunc0(LoadReflowPage, task), StrL("ReflowPage"));
            if (thread) {
                SafeCloseThreadHandle(&thread);
                return;
            }
            AtomicIntDec(&gDangerousThreadCount);
            view->pendingPages--;
            task->engine->Release();
            str::Free(task->id);
            delete task;
            error = 1;
            result = ReflowQuote(StrL("Could not start page reflow."));
        }
    } else if (str::Eq(action, StrL("annotate"))) {
        if (!AnnotateContextReflow(win, ReflowField(data, StrL("quote")), ReflowField(data, StrL("context")),
                                   ReflowField(data, StrL("ranges")))) {
            error = 1;
            result =
                ReflowQuote(StrL("Could not locate the selected text in the original document. Please use the original "
                                 "view for this selection."));
        }
    } else if (str::Eq(action, StrL("positions"))) {
        ContextNotesReflowPositions(win, ReflowField(data, StrL("items")));
    } else if (str::Eq(action, StrL("focus"))) {
        ContextNotesReflowFocus(win, ReflowField(data, StrL("id")));
    } else if (str::Eq(action, StrL("delete"))) {
        ContextNoteDelete(win, ReflowField(data, StrL("id")));
    } else if (str::Eq(action, StrL("position"))) {
        int page = atoi(CStrTemp(ReflowField(data, StrL("page"))));
        if (page > 0 && page <= view->engine->PageCount() && page != view->page) {
            view->page = page;
            win->AsFixed()->GoToPage(page, false);
            ScheduleUiUpdate(win, kUiToolbarDirty);
        }
    } else if (str::Eq(action, StrL("zoom"))) {
        ReflowSetZoom(view, atoi(CStrTemp(ReflowField(data, StrL("zoom")))));
    } else if (str::Eq(action, StrL("copy"))) {
        if (!HasPermission(Perm::CopySelection) || !view->engine->allowsCopyingText)
            error = 1;
        else
            CopyTextToClipboard(ReflowField(data, StrL("text")));
    } else if (str::Eq(action, StrL("close"))) {
        ReflowDocumentHandleCommand(win, CmdToggleDocumentReflow);
    } else {
        error = 1;
        result = ReflowQuote(StrL("Unsupported reflow action."));
    }
    view->Resolve(id, error, result);
}

static ReflowView* CreateReflow(MainWindow* win) {
    auto* view = new ReflowView();
    view->win = win;
    view->frame = win->hwndFrame;
    view->tab = win->CurrentTab();
    view->engine = win->AsFixed()->GetEngine();
    view->engine->AddRef();
    view->page = win->ctrl->CurrentPageNo();
    view->documentPath = str::Dup(view->tab->filePath);
    view->epoch = ++gReflowEpoch;
    view->enabled = true;
    view->dataDir = str::Dup(GetWebViewDataDirTemp());
    view->resourceUriPrefix = wstr::Dup(WStrL(L"https://sumatra-reflow/"));
    view->resourceProvider = {nullptr, ReflowResource};
    view->events.ctx = view;
    view->events.jsCall = ReflowCall;
    view->events.navigationStarting = ReflowNavigation;
    view->events.resolveAccelCmd = ReflowAccel;
    view->allowClipboardRead = false;
    view->allowExternalDrop = false;
    view->defaultBackgroundColor = MkRgb(255, 255, 255);
    CreateWebViewArgs args;
    args.parent = win->hwndCanvas;
    args.pos = HwndClientRect(args.parent);
    if (!view->Create(args)) {
        delete view;
        return nullptr;
    }
    VecAppend(gReflowViews, view);
    view->Bind(StrL("reflow"));
    view->Navigate(StrL("https://sumatra-reflow/reflow.html"));
    view->SetIsVisible(true);
    return view;
}

void ReflowDocumentLayout(MainWindow* win) {
    auto* view = FindReflow(win);
    if (!view) return;
    auto* dm = win->AsFixed();
    if (view->tab != win->CurrentTab() || !dm || view->engine != dm->GetEngine() ||
        !str::EqI(view->documentPath, win->CurrentTab()->filePath)) {
        ReflowDocumentDestroy(win);
        return;
    }
    bool visible = ReflowDocumentVisible(win);
    view->SetIsVisible(visible);
    if (!visible) return;
    // Native scrollbars belong to the original fixed-layout view. Reflow has
    // its own vertical scroll and never changes the PDF's zoom or page boxes.
    ShowScrollBar(win->hwndCanvas, SB_BOTH, FALSE);
    Rect rect = HwndClientRect(win->hwndCanvas);
    if (!(HwndClientRect(view->hwnd).Size() == rect.Size())) HwndMoveWindow(view->hwnd, &rect);
    int page = dm->CurrentPageNo();
    if (view->page != page) {
        view->page = page;
        ReflowEvent(view, StrL("reflownavigate"), fmt("{\"page\":%d}", page));
    }
}

void ReflowDocumentDestroy(MainWindow* win) {
    auto* view = FindReflow(win);
    if (!view) return;
    VecRemove(gReflowViews, view);
    delete view;
}

bool ReflowDocumentHandleCommand(MainWindow* win, int cmdId) {
    if (cmdId == CmdToggleDocumentReflow) {
        auto* view = FindReflow(win);
        if (ReflowDocumentVisible(win)) {
            view->enabled = false;
            view->SetIsVisible(false);
            auto* dm = win->AsFixed();
            if (dm) dm->cb->UpdateScrollbars(dm, dm->GetCanvasSize());
        } else {
            if (!ReflowDocumentAvailable(win)) return true;
            if (view &&
                (!view->ready || view->tab != win->CurrentTab() || view->engine != win->AsFixed()->GetEngine())) {
                ReflowDocumentDestroy(win);
                view = nullptr;
            }
            if (!view) view = CreateReflow(win);
            if (!view) return true;
            view->enabled = true;
            auto* dm = win->AsFixed();
            if (dm) dm->cb->UpdateScrollbars(dm, dm->GetCanvasSize());
            ReflowDocumentLayout(win);
            ReflowDocumentUpdateNotes(win);
            // A toggle may have hidden the view while page extraction was in
            // flight. Restart its bounded page window when shown again.
            ReflowEvent(view, StrL("reflownavigate"), fmt("{\"page\":%d}", view->page));
            view->Focus();
        }
        ToolbarUpdateStateForWindow(win, false);
        ScheduleUiUpdate(win, kUiForceRelayout | kUiToolbarDirty);
        ScheduleRepaint(win, 0);
        return true;
    }
    if (!ReflowDocumentVisible(win)) return false;
    auto* view = FindReflow(win);
    if (cmdId == CmdZoomIn || cmdId == CmdZoomOut)
        return ReflowDocumentZoomBy(win, cmdId == CmdZoomIn ? 1.1f : 1.f / 1.1f);
    switch (cmdId) {
        case CmdZoom6400:
        case CmdZoom3200:
        case CmdZoom1600:
        case CmdZoom800:
        case CmdZoom400:
            ReflowSetZoom(view, 400);
            return true;
        case CmdZoom200:
            ReflowSetZoom(view, 200);
            return true;
        case CmdZoom150:
            ReflowSetZoom(view, 150);
            return true;
        case CmdZoom125:
            ReflowSetZoom(view, 125);
            return true;
        case CmdZoom50:
        case CmdZoom25:
        case CmdZoom12_5:
        case CmdZoom8_33:
            ReflowSetZoom(view, 50);
            return true;
        case CmdZoom100:
        case CmdZoomActualSize:
        case CmdZoomFitPage:
        case CmdZoomFitWidth:
        case CmdZoomFitHeight:
        case CmdZoomFitByOrientation:
        case CmdZoomFitContent:
        case CmdZoomShrinkToFit:
        case CmdZoomFitVisible:
        case CmdZoomFitWidthAndContinuous:
        case CmdZoomFitPageAndSinglePage:
        case CmdZoomCustom:
        case CmdZoomToSelection:
            ReflowSetZoom(view, 100);
            return true;
        case CmdContextAnnotate:
            view->Eval(StrL("document.querySelector('#annotate').click()"));
            return true;
        case CmdFindFirst:
            view->ShowFindUI();
            return true;
        case CmdCopySelection:
            view->Eval(
                StrL("__sumatra__.call('reflow',JSON.stringify({action:'copy',text:getSelection().toString()}))"));
            return true;
        case CmdSelectAll:
            view->Eval(StrL("getSelection().selectAllChildren(document.querySelector('#pages'))"));
            return true;
    }
    return false;
}
