/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#if defined(SUMATRA_NG)
#include "gui/GpuiBridge.h"
#else
#include "base/Base.h"
#endif
#include "base/File.h"
#include "base/Win.h"
#include "base/JsonParser.h"
#include "base/UITask.h"
#include <cmath>
#if !OS_WIN
#include <sys/stat.h>
#include <unistd.h>
#endif
#include "gui/UIModels.h"
#include "gui/Layout.h"
#if !defined(SUMATRA_NG)
#include "gui/win/WinGui.h"
#endif
#if defined(SUMATRA_NG)
#include "NotesWebView.h"
#else
#include "gui/win/WebView.h"
#endif
#include "VirtKeys.h"
#include "Settings.h"
#include "AppSettings.h"
#include "Theme.h"
#include "AppTools.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "TextSelection.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "ContextNotes.h"
#include "ContextNotesPlatform.h"
#include "AIChatTypes.h"
#include "WindowTab.h"
#include "Commands.h"
#if !defined(SUMATRA_NG)
#include "Canvas.h"
#endif
#include "Toolbar.h"
#if !defined(SUMATRA_NG)
#include "ContextNoteOverlay.h"
#else
void HideContextNoteActions(MainWindow*);
void DestroyContextNoteActions(MainWindow*);
void ShowContextNoteActions(MainWindow*, Str, Point);
void ContextNoteDelete(MainWindow*, Str);
void ContextNoteSpeak(MainWindow*, Str);
#endif
#include "ReflowDocument.h"

struct ReflowCache;
static void DropReflowCache(ReflowCache* cache);

struct ReflowCenter {
    int page = 1;
    int glyph = -1;
    double x = 0;
    double y = 0;
};

#if !defined(SUMATRA_NG)
using NotesWebBase = WebviewWnd;
#endif
struct ReflowView : NotesWebBase {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    WindowTab* tab = nullptr;
    EngineBase* engine = nullptr; // AddRef: survives tab closure until view destruction
    u64 epoch = 0;
    bool enabled = false;
    bool blocked = false;
    bool ready = false;
    bool closing = false;
    int page = 1;
    int zoom = 100;
    int navigation = 0;
    int pendingPages = 0;
    Str documentPath;
    ReflowCache* cache = nullptr;
    ReflowCenter center;

    ~ReflowView() override {
        DropReflowCache(cache);
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

static bool ReflowNumber(Str data, Str key, double& result) {
    json::Reader reader(data);
    Str segment = str::JoinTemp(StrL("/"), key);
    Str number;
    for (json::Value& value : reader)
        if (json::PathMatch(value.path, segment) && value.type == json::Type::Number)
            number = str::DupTemp(value.value);
    if (!reader.Ok() || len(number) == 0) return false;
    char* text = CStrTemp(number);
    char* end = nullptr;
    double parsed = strtod(text, &end);
    if (end == text || *end != 0 || !std::isfinite(parsed)) return false;
    result = parsed;
    return true;
}

static int ReflowInt(Str data, Str key, int fallback = 0) {
    double number;
    if (!ReflowNumber(data, key, number) || number < INT_MIN || number > INT_MAX) return fallback;
    int result = (int)number;
    return number == result ? result : fallback;
}

static constexpr double kReflowCoordLimit = 1e6;

static TempStr CenterJson(const ReflowCenter& center) {
    return fmt("{\"page\":%d,\"glyph\":%d,\"x\":%g,\"y\":%g}", center.page, center.glyph, center.x, center.y);
}

static ReflowCenter OriginalCenter(MainWindow* win) {
    ReflowCenter result;
    auto* dm = win->AsFixed();
    Size size = dm->GetViewPort().Size();
    Point screen(size.dx / 2, size.dy / 2);
    result.page = dm->GetPageNoByPoint(screen);
    if (!dm->ValidPageNo(result.page)) result.page = dm->GetPageNextToPoint(screen);
    if (!dm->ValidPageNo(result.page)) result.page = dm->CurrentPageNo();
    PointF point = dm->CvtFromScreen(screen, result.page);
    result.x = point.x;
    result.y = point.y;
    auto* engine = dm->GetEngine();
    TextSelection selection(engine);
    int glyph = selection.FindClosestGlyphAt(result.page, point.x, point.y);
    int count = 0;
    Rect* coords = nullptr;
    engine->GetTextForPage(result.page, &count, &coords);
    if (glyph >= 0 && glyph < count && !coords[glyph].IsEmpty()) {
        Rect box = dm->CvtToScreen(result.page, ToRectF(coords[glyph]));
        int dx = std::max({box.x - screen.x, screen.x - box.Right(), 0});
        int dy = std::max({box.y - screen.y, screen.y - box.Bottom(), 0});
        if (dx <= box.dy && dy <= box.dy) result.glyph = glyph;
    }
    return result;
}

static void ShowOriginalCenter(ReflowView* view, Str data) {
    auto* win = view->win;
    auto* dm = win->AsFixed();
    ReflowCenter center = view->center;
    int page = ReflowInt(data, StrL("page"));
    double x, y;
    // The page may still be loading when the user returns to the original.
    // Incomplete center data keeps the position captured before reflow.
    if (dm->ValidPageNo(page) && ReflowNumber(data, StrL("x"), x) && ReflowNumber(data, StrL("y"), y) &&
        std::abs(x) <= kReflowCoordLimit && std::abs(y) <= kReflowCoordLimit) {
        center.page = page;
        center.glyph = ReflowInt(data, StrL("glyph"), -1);
        center.x = x;
        center.y = y;
    }
    view->enabled = view->closing = false;
    view->SetIsVisible(false);
    dm->cb->UpdateScrollbars(dm, dm->GetCanvasSize());
    if (dm->ValidPageNo(center.page) && std::abs(center.x) <= kReflowCoordLimit &&
        std::abs(center.y) <= kReflowCoordLimit) {
        int count = 0;
        Rect* coords = nullptr;
        dm->GetEngine()->GetTextForPage(center.page, &count, &coords);
        if (center.glyph >= 0 && center.glyph < count && !coords[center.glyph].IsEmpty()) {
            Rect box = coords[center.glyph];
            center.x = box.x + box.dx * .5;
            center.y = box.y + box.dy * .5;
        }
        dm->GoToPage(center.page, false);
        Size size = dm->GetViewPort().Size();
        Point screen = dm->CvtToScreen(center.page, PointF((float)center.x, (float)center.y));
        int dx = screen.x - size.dx / 2;
        int dy = screen.y - size.dy / 2;
        if (dx != 0) dm->ScrollXBy(dx);
        if (dy != 0) dm->ScrollYBy(dy, false);
    }
    ToolbarUpdateStateForWindow(win, false);
    NotesUpdate(win);
    ScheduleRepaint(win, 0);
}

struct ReflowCacheEntry {
    int page;
    i64 offset;
    int size;
};

// One temporary JSONL document: explicit page order, ordered XHTML and the
// unchanged source codepoints used by notes. A byte index avoids rereading
// earlier pages. Worker references keep the file alive during tab closure.
struct ReflowCache {
    AtomicInt refs = 1;
    Mutex mutex;
    Str path;
    file::FileHandle handle = file::kInvalidFileHandle;
    Vec<ReflowCacheEntry> entries;
    int hits = 0;

    ReflowCache(Str source, int pageCount) {
        path = str::Dup(GetTempFilePathTemp(StrL("srf")));
        if (len(path) == 0) return;
        Str named = str::JoinTemp(path, StrL(".ordered.html.jsonl"));
        if (file::Rename(named, path)) {
            str::Free(path);
            path = str::Dup(named);
        }
#if OS_WIN
        handle =
            CreateFileW(CWStrTemp(path), GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE,
                        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
#else
        handle = file::OpenReadWrite(path, true);
        if (handle != file::kInvalidFileHandle) {
            chmod(CStrTemp(path), 0600);
            unlink(CStrTemp(path));
        }
#endif
        if (handle == file::kInvalidFileHandle) return;
        file::WriteAll(handle,
                       fmt("{\"format\":\"SumatraPDF ordered XHTML\",\"version\":1,\"source\":%s,\"pageCount\":%d}\n",
                           ReflowQuote(source), pageCount));
        logf("reflow cache created: %s\n", path);
    }

    ~ReflowCache() {
        if (handle == file::kInvalidFileHandle) {
            if (path) file::Delete(path);
        } else {
            file::Close(handle);
        }
        str::Free(path);
    }

    bool Read(const ReflowCacheEntry& entry, ReflowPageData& data) {
        constexpr int maxRecordBytes = 128 * 1024 * 1024;
        if (entry.size <= 0 || entry.size > maxRecordBytes) return false;
#if OS_WIN
        LARGE_INTEGER offset;
        offset.QuadPart = entry.offset;
        if (!SetFilePointerEx(handle, offset, nullptr, FILE_BEGIN)) return false;
#endif
        Str record(AllocArray<char>(entry.size), entry.size);
#if OS_WIN
        DWORD count = 0;
        bool ok = ::ReadFile(handle, record.s, entry.size, &count, nullptr) && count == (DWORD)entry.size;
#else
        int done = 0;
        while (done < entry.size) {
            ssize_t n = pread(handle, record.s + done, entry.size - done, entry.offset + done);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            done += n;
        }
        bool ok = done == entry.size;
#endif
        if (ok) {
            json::Reader reader(record);
            int page = 0;
            for (json::Value& value : reader) {
                if (json::PathMatch(value.path, StrL("/page")))
                    page = atoi(CStrTemp(value.value));
                else if (json::PathMatch(value.path, StrL("/html")))
                    data.html = str::Dup(value.value);
                else if (json::PathMatch(value.path, StrL("/sourceText")))
                    data.sourceText = str::Dup(value.value);
                else if (json::PathMatch(value.path, StrL("/displayText")))
                    data.displayText = str::Dup(value.value);
            }
            ok = reader.Ok() && page == entry.page && len(data.html) > 0;
        }
        str::Free(record);
        if (!ok) FreeReflowPageData(&data);
        return ok;
    }

    ReflowPageData Load(EngineBase* engine, int page, bool& hit) {
        ScopedMutex lock(&mutex);
        ReflowPageData data;
        for (int i = 0; i < len(entries); i++) {
            if (entries[i].page != page) continue;
            if (Read(entries[i], data)) {
                hit = true;
                hits++;
                return data;
            }
            VecRemoveAt(entries, i);
            break;
        }
        data = engine->ExtractReflowPage(page);
        if (handle == file::kInvalidFileHandle || data.error) return data;
        Str record = fmt("{\"page\":%d,\"html\":%s,\"sourceText\":%s,\"displayText\":%s}\n", page,
                         ReflowQuote(data.html), ReflowQuote(data.sourceText), ReflowQuote(data.displayText));
        i64 offset = file::SeekEnd(handle);
        if (offset < 0 || !file::WriteAll(handle, record)) return data;
        ReflowCacheEntry entry{page, offset, len(record)};
        VecAppend(entries, entry);
        ReflowPageData stored;
        if (Read(entry, stored)) {
            FreeReflowPageData(&data);
            return stored;
        }
        return data;
    }
};

static void DropReflowCache(ReflowCache* cache) {
    if (cache && AtomicIntDec(&cache->refs) == 0) delete cache;
}

static void ReflowEvent(ReflowView* view, Str event, Str detail) {
    if (view && view->ready)
        view->Eval(fmt("dispatchEvent(new CustomEvent(%s,{detail:%s}))", ReflowQuote(event), detail));
}

void ReflowDocumentUpdateTheme(MainWindow* win) {
    ReflowEvent(FindReflow(win), StrL("themechange"), ContextNotesThemeJsonTemp());
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
    NotesUpdate(view->win);
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
    ReflowCache* cache = nullptr;
    bool cached = false;
};

static void FinishReflowPage(ReflowPageTask* task) {
    ReflowView* view =
        IsMainWindowValid(task->win) && NotesFrame(task->win) == task->frame ? FindReflow(task->win) : nullptr;
    if (view && view->epoch == task->epoch) {
        view->pendingPages--;
        if (ReflowDocumentVisible(task->win) && view->engine == task->engine) {
            view->Resolve(
                task->id, 0,
                fmt("{\"page\":%d,\"html\":%s,\"sourceText\":%s,\"displayText\":%s,\"error\":%s,\"cached\":%s}",
                    task->page, ReflowQuote(task->data.html), ReflowQuote(task->data.sourceText),
                    ReflowQuote(task->data.displayText), ReflowQuote(task->data.error),
                    task->cached ? StrL("true") : StrL("false")));
        } else {
            view->Resolve(task->id, 1, ReflowQuote(StrL("Reflow view is no longer active.")));
        }
    }
    FreeReflowPageData(&task->data);
    str::Free(task->id);
    task->engine->Release();
    DropReflowCache(task->cache);
    delete task;
}

static void LoadReflowPage(ReflowPageTask* task) {
    task->data = task->cache ? task->cache->Load(task->engine, task->page, task->cached)
                             : task->engine->ExtractReflowPage(task->page);
    task->engine->ReleaseTextExtractionThreadContext();
    uitask::Post(MkFunc0(FinishReflowPage, task), "ReflowPage");
    AtomicIntDec(&gDangerousThreadCount);
}

static TempStr ReflowAssets() {
    return NotesAssetsTemp();
}

static bool ReflowResource(void*, Str resource, WebViewResourceResult* out) {
    while (len(resource) > 0 && resource.s[0] == '/') resource = Str(resource.s + 1, len(resource) - 1);
    bool html = str::Eq(resource, StrL("reflow.html"));
    bool css = str::Eq(resource, StrL("reflow.css")) || str::Eq(resource, StrL("theme.css"));
    bool js = str::Eq(resource, StrL("reflow.js")) || str::Eq(resource, StrL("reflow-model.js")) ||
              str::Eq(resource, StrL("theme.js"));
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
    if (ContextNotesThemeCall(action, result)) {
        view->Resolve(id, 0, result);
        return;
    }
    int error = 0;
    if (str::Eq(action, StrL("ready"))) {
        view->ready = true;
        result = fmt("{\"page\":%d,\"pageCount\":%d,\"zoom\":%d,\"notes\":%s,\"center\":%s,\"navigation\":%d}",
                     view->page, view->engine->PageCount(), view->zoom, ContextNotesReflowState(win),
                     CenterJson(view->center), view->navigation);
    } else if (str::Eq(action, StrL("cache-info"))) {
        auto* cache = view->cache;
        if (cache) {
            ScopedMutex lock(&cache->mutex);
            result = fmt("{\"path\":%s,\"pages\":%d,\"hits\":%d,\"bytes\":%lld}", ReflowQuote(cache->path),
                         len(cache->entries), cache->hits, file::SeekEnd(cache->handle));
        }
    } else if (str::Eq(action, StrL("page"))) {
        int page = ReflowInt(data, StrL("page"));
        if (page < 1 || page > view->engine->PageCount() || view->pendingPages >= 5) {
            error = 1;
            result = ReflowQuote(StrL("Invalid page or too many pending reflow pages."));
        } else {
            auto* task = new ReflowPageTask();
            task->win = win;
            task->frame = NotesFrame(win);
            task->engine = view->engine;
            task->epoch = view->epoch;
            task->page = page;
            task->id = str::Dup(id);
            task->engine->AddRef();
            task->cache = view->cache;
            if (task->cache) AtomicIntInc(&task->cache->refs);
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
            DropReflowCache(task->cache);
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
    } else if (str::Eq(action, StrL("speak"))) {
        ContextNoteSpeak(win, ReflowField(data, StrL("id")));
    } else if (str::Eq(action, StrL("delete"))) {
        ContextNoteDelete(win, ReflowField(data, StrL("id")));
    } else if (str::Eq(action, StrL("position"))) {
        int page = ReflowInt(data, StrL("page"));
        // A queued scroll notification must not undo a newer TOC/page command.
        if (win->AsFixed()->CurrentPageNo() != view->page) ReflowDocumentLayout(win);
        int navigation = ReflowInt(data, StrL("navigation"), -1);
        if (navigation == view->navigation && page > 0 && page <= view->engine->PageCount() && page != view->page) {
            view->page = page;
            win->AsFixed()->GoToPage(page, false);
            NotesUpdate(win);
        }
    } else if (str::Eq(action, StrL("zoom"))) {
        ReflowSetZoom(view, ReflowInt(data, StrL("zoom"), view->zoom));
    } else if (str::Eq(action, StrL("copy"))) {
        if (!HasPermission(Perm::CopySelection) || !view->engine->allowsCopyingText)
            error = 1;
        else
            NotesCopy(win, ReflowField(data, StrL("text")));
    } else if (str::Eq(action, StrL("close"))) {
        ShowOriginalCenter(view, data);
    } else if (str::Eq(action, StrL("original-center"))) {
        result = CenterJson(OriginalCenter(win));
    } else {
        error = 1;
        result = ReflowQuote(StrL("Unsupported reflow action."));
    }
    view->Resolve(id, error, result);
}

static ReflowView* CreateReflow(MainWindow* win) {
    auto* view = new ReflowView();
    view->win = win;
    view->frame = NotesFrame(win);
    view->tab = win->CurrentTab();
    view->engine = win->AsFixed()->GetEngine();
    view->engine->AddRef();
    view->page = win->ctrl->CurrentPageNo();
    view->documentPath = str::Dup(view->tab->filePath);
    view->cache = new ReflowCache(view->documentPath, view->engine->PageCount());
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
    view->defaultBackgroundColor = ThemeWindowBackgroundColor();
    CreateWebViewArgs args;
    args.parent = NotesCanvas(win);
#if !defined(SUMATRA_NG)
    args.pos = HwndClientRect(args.parent);
#endif
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
    bool visible = ReflowDocumentVisible(win) && !view->blocked;
    view->SetIsVisible(visible);
    if (!visible) return;
    // Native scrollbars belong to the original fixed-layout view. Reflow has
    // its own vertical scroll and never changes the PDF's zoom or page boxes.
#if !defined(SUMATRA_NG)
    ShowScrollBar(NotesCanvas(win), SB_BOTH, FALSE);
    Rect rect = HwndClientRect(NotesCanvas(win));
    if (!(HwndClientRect(view->hwnd).Size() == rect.Size())) HwndMoveWindow(view->hwnd, &rect);
#endif
    int page = dm->CurrentPageNo();
    if (view->page != page) {
        view->page = page;
        view->navigation++;
        ReflowEvent(view, StrL("reflownavigate"), fmt("{\"page\":%d,\"navigation\":%d}", page, view->navigation));
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
            if (view->closing) return true;
            if (view->ready) {
                view->closing = true;
                ReflowEvent(view, StrL("reflowcapture"), StrL("{}"));
            } else
                ShowOriginalCenter(view, {});
            return true;
        } else {
            if (!ReflowDocumentAvailable(win)) return true;
            ReflowCenter center = OriginalCenter(win);
            if (view &&
                (!view->ready || view->tab != win->CurrentTab() || view->engine != win->AsFixed()->GetEngine())) {
                ReflowDocumentDestroy(win);
                view = nullptr;
            }
            if (!view) view = CreateReflow(win);
            if (!view) return true;
            view->enabled = true;
            view->center = center;
            auto* dm = win->AsFixed();
            if (dm) dm->cb->UpdateScrollbars(dm, dm->GetCanvasSize());
            ReflowDocumentLayout(win);
            view->page = center.page;
            ReflowDocumentUpdateNotes(win);
            // A toggle may have hidden the view while page extraction was in
            // flight. Restart its bounded page window when shown again.
            view->navigation++;
            ReflowEvent(
                view, StrL("reflownavigate"),
                fmt("{\"page\":%d,\"center\":%s,\"navigation\":%d}", view->page, CenterJson(center), view->navigation));
            view->Focus();
        }
        ToolbarUpdateStateForWindow(win, false);
        NotesUpdate(win);
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

#if defined(SUMATRA_NG)
gp::El* ReflowDocumentBuild(MainWindow* win, gp::Ctx* cx) {
    auto* view = FindReflow(win);
    return view && ReflowDocumentVisible(win) ? BrowserViewBuild(view->browser, cx) : nullptr;
}
bool ReflowDocumentReady(MainWindow* win) {
    auto* view = FindReflow(win);
    return view && view->ready;
}
#endif

#if defined(SUMATRA_NG)
TempStr ReflowDocumentTestTemp(MainWindow* win, Str script) {
    auto* view = FindReflow(win);
    if (!view) return StrL("no-view");
    if (script) view->TestEval(script);
    return str::DupTemp(view->testResult);
}
#endif

#if defined(SUMATRA_NG)
void ReflowDocumentBlockView(MainWindow* win, bool blocked) {
    auto* view = FindReflow(win);
    if (view) {
        view->blocked = blocked;
        view->SetIsVisible(ReflowDocumentVisible(win) && !blocked);
    }
}
#endif
