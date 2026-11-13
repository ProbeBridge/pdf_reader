/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */
#include "gui/GpuiBridge.h"
#include "base/File.h"
#include "base/JsonParser.h"
#include "base/UITask.h"
#include "gui/UIModels.h"
#include "Settings.h"
#include "AppSettings.h"
#include "AppTools.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "ContextNotes.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "ReflowDocument.h"
#include "Translations.h"
#include "SvgIcons.h"
#include "NotesPlatform.h"
#include "gui/AppShell.h"
#include "gui/DocCanvas.h"
#include "NotesWebView.h"
#include "Toolbar.h"
#include "SumatraDialogs.h"

HWND NotesFrame(MainWindow* win) {
    return (HWND)win->gpuiWin;
}
HWND NotesCanvas(MainWindow* win) {
    return NotesFrame(win);
}
bool NotesReadingActive(MainWindow* win) {
    return win->gpuiWin && win->gpuiWin->active && !win->gpuiWin->minimized;
}
void NotesRelayout(MainWindow* win) {
    AppShellSyncCanvasSize(win);
    AppShellInvalidate(win);
}
void NotesUpdate(MainWindow* win) {
    ToolbarUpdateStateForWindow(win, false);
    NotesRelayout(win);
}
bool NotesCopy(MainWindow* win, Str text) {
    CopyTextToClipboard(win, text);
    return true;
}
bool NotesPickBooks(MainWindow* win, StrVec* paths) {
    return AppShellPromptForFiles(win, {}, paths);
}
void NotesExecute(MainWindow* win, int cmd) {
    ExecuteCmd(win, cmd);
}
void NotesPaintRect(Gfx* gfx, Rect rc) {
    CanvasFillRects(gfx->ctx, &rc, 1, MkRgb(255, 219, 112), 75, 0);
    CanvasDrawLine(gfx->ctx, Point(rc.x, rc.Bottom()), Point(rc.Right(), rc.Bottom()), MkRgb(153, 84, 0), 1);
}
void NotesTooltip(MainWindow* win, Str text, Rect rc) {
    str::ReplaceWithCopy(&win->linkTooltip, text);
    win->linkTooltipRc = rc;
}
Point NotesCursorPoint(MainWindow* win) {
    float scale = CanvasScale(win);
    return Point((int)((win->gpuiWin->mouseX - win->canvasRc.x) / scale),
                 (int)((win->gpuiWin->mouseY - win->canvasRc.y) / scale));
}
void NotesHandCursor(MainWindow* win) {
    win->canvasCursor = (int)gp::CursorKind::Pointer;
}
struct NotesExportTask {
    MainWindow* win;
    HWND frame;
    Str id;
    Str value;
};
static void NotesExportDone(NotesExportTask* task, SavePathArgs* args) {
    bool ok = args->path && file::WriteFile(args->path, task->value);
    if (IsMainWindowValid(task->win) && NotesFrame(task->win) == task->frame)
        ContextNotesExported(task->win, task->id, ok);
    str::Free(task->id);
    str::Free(task->value);
    delete task;
}
void NotesExport(MainWindow* win, Str id, Str value) {
    auto* task = new NotesExportTask{win, NotesFrame(win), str::Dup(id), str::Dup(value)};
    auto* args = new SavePathArgs();
    args->win = win;
    args->title = str::Dup(StrL("Export notes"));
    args->initialPath = str::Dup(StrL("SumatraPDF-notes.json"));
    args->defExt = str::Dup(StrL(".json"));
    args->onDone = MkFunc1(NotesExportDone, task);
    ShowSavePathDialog(args);
}

NotesWebBase::~NotesWebBase() {
    BrowserViewDelete(browser);
    str::Free(dataDir);
    wstr::Free(resourceUriPrefix);
    str::Free(bound);
    str::Free(testResult);
    str::Free(host);
}
bool NotesWebBase::Create(const CreateWebViewArgs& args) {
    auto* win = (MainWindow*)nullptr;
    for (auto* candidate : gWindows)
        if (NotesFrame(candidate) == args.parent) {
            win = candidate;
            break;
        }
    if (!win) return false;
    bool reflow = str::Contains(ToUtf8Temp(resourceUriPrefix), StrL("reflow"));
    host = str::Dup(reflow ? StrL("https://sumatrapdf.reflow/") : StrL("https://sumatrapdf.notes/"));
    browser = BrowserViewCreate(win, nullptr, this, host);
    BrowserViewSetBackground(browser, defaultBackgroundColor);
    return browser != nullptr;
}
void NotesWebBase::Bind(Str method) {
    str::ReplaceWithCopy(&bound, method);
}
void NotesWebBase::Navigate(Str url) {
    Str page = path::GetBaseNameTemp(url);
    BrowserViewNavigate(browser, str::JoinTemp(host, page));
}
void NotesWebBase::Eval(Str js) {
    BrowserViewEval(browser, js);
}
void NotesWebBase::Resolve(Str id, int status, Str result) {
    Eval(fmt("window.__sumatra__.onReply(\"%s\",%d,\"%s\")", json::EscapeStrTemp(id), status,
             json::EscapeStrTemp(result)));
}
void NotesWebBase::SetIsVisible(bool show) {
    visible = show;
    BrowserViewSetVisible(browser, show);
}
bool NotesWebBase::OnBeforeNavigate(Str url, bool newWindow) {
    return events.navigationStarting && events.navigationStarting(events.ctx, url, newWindow);
}
Str NotesWebBase::GetDataForUrl(Str url) {
    int idx = paths.Find(url);
    if (idx >= 0) return assets[idx];
    WebViewResourceResult res;
    if (!resourceProvider.fn || !resourceProvider.fn(resourceProvider.ctx, url, &res)) return {};
    Str data((char*)res.data, res.dataLen);
    paths.Append(url);
    assets.Append(data);
    str::Free(data);
    str::Free(res.contentType);
    return assets[len(assets) - 1];
}
void NotesWebBase::OnJsCall(Str id, Str method, Str params) {
    if (str::Eq(method, bound) && events.jsCall && len(params) <= 64 * 1024 * 1024)
        events.jsCall(events.ctx, id, method, params);
    else
        Resolve(id, 1, StrL("\"Unsupported request\""));
}

int ContextNotesPanelDx(MainWindow* win) {
    if (!ContextNotesVisible(win)) return 0;
    int maxDx = std::max(220, win->frameRc.dx / 2);
    int dx = gSettings->contextNotesWidth > 0 ? gSettings->contextNotesWidth : 360;
    return limitValue(dx, 220, maxDx);
}
struct NotesPanelView {
    static gp::El* Render(NotesPanelView*, gp::Ctx* cx) { return gp::Div(cx->a); }
    MainWindow* win = nullptr;
    static void Drag(NotesPanelView* self, gp::Ctx* cx, const gp::DragMoveEvent* ev) {
        auto* win = self->win;
        gSettings->contextNotesWidth =
            limitValue(win->frameRc.dx - (int)ev->event.x, 220, std::max(220, win->frameRc.dx / 2));
        NotesRelayout(win);
        gp::Notify(cx);
    }
    static void Up(NotesPanelView*, gp::Ctx*, const gp::MouseUpEvent*) { ScheduleSaveSettings(); }
};
static Vec<MainWindow*> gPanelWindows;
static Vec<gp::Entity<NotesPanelView>> gPanelViews;
void NotesPanelDestroy(MainWindow* win) {
    int idx = VecFind(gPanelWindows, win);
    if (idx < 0) return;
    gp::EntityDrop(win->gpuiWin->app, gPanelViews[idx].id);
    VecRemoveAt(gPanelWindows, idx);
    VecRemoveAt(gPanelViews, idx);
}
gp::El* ContextNotesPanelBuild(MainWindow* win, gp::Ctx* cx) {
    if (!ContextNotesVisible(win)) return nullptr;
    int idx = VecFind(gPanelWindows, win);
    if (idx < 0) {
        auto entity = gp::EntityNew<NotesPanelView>(cx->app);
        entity.Get(cx)->win = win;
        VecAppend(gPanelWindows, win);
        VecAppend(gPanelViews, entity);
        idx = len(gPanelWindows) - 1;
    }
    auto entity = gPanelViews[idx];
    auto* content = ContextNotesViewBuild(win, cx, false);
    auto* row = gp::Div(cx->a)->FlexRow()->W((float)ContextNotesPanelDx(win))->H(gp::kFill)->Shrink0();
    row->Child(gp::Div(cx->a)
                   ->W(4)
                   ->H(gp::kFill)
                   ->Shrink0()
                   ->Bg(gp::ThemeNow(cx->app).border)
                   ->Cursor(gp::CursorKind::ColResize)
                   ->PathClick(GStrL("notes-splitter"))
                   ->OnDrag(GStrL("notes-resize"))
                   ->OnDragMove(gp::ListenTo(entity, &NotesPanelView::Drag))
                   ->OnMouseUp(gp::ListenTo(entity, &NotesPanelView::Up))
                   ->OnMouseUpOut(gp::ListenTo(entity, &NotesPanelView::Up)));
    if (content) row->Child(gp::Div(cx->a)->Flex1()->H(gp::kFill)->Child(content));
    return row;
}

void NotesWebBase::TestEval(Str script) {
    str::Free(testResult);
    testResult = {};
    Eval(
        fmt("Promise.resolve().then(()=>{return (%s)}).then(value=>"
            "__sumatra__.notify('notes-test',JSON.stringify({ok:true,value})),error=>"
            "__sumatra__.notify('notes-test',JSON.stringify({ok:false,error:String(error)})))",
            script));
}
void NotesWebBase::OnJsNotify(Str method, Str params) {
    if (!str::Eq(method, StrL("notes-test"))) return;
    json::Reader reader(params);
    for (json::Value& value : reader) {
        if (json::PathMatch(value.path, StrL("i0"))) str::ReplaceWithCopy(&testResult, value.value);
    }
}

struct NotesCommandTask {
    MainWindow* win;
    HWND frame;
    int cmd;
};
static void NotesRunCommand(NotesCommandTask* task) {
    if (IsMainWindowValid(task->win) && NotesFrame(task->win) == task->frame) ExecuteCmd(task->win, task->cmd);
    delete task;
}
void NotesPostCommand(MainWindow* win, int cmd) {
    uitask::Post(MkFunc0(NotesRunCommand, new NotesCommandTask{win, NotesFrame(win), cmd}), "NotesCommand");
}

struct NotesActionsView {
    MainWindow* win = nullptr;
    Str id;
    Point anchor;
    gp::Bounds bounds;
    WindowTab* tab = nullptr;
    DisplayModel* model = nullptr;
    ScrollState scroll;
    Rect viewport;
    float zoom = 0;
    int rotation = 0;
    ~NotesActionsView() { str::Free(id); }
    static void Action(NotesActionsView* self, gp::Ctx*, const gp::ClickEvent*, int64_t action);
};
static Vec<gp::Entity<NotesActionsView>> gNoteActionViews;

enum class ActionLookup {
    Existing,
    Create
};
static gp::Entity<NotesActionsView> ActionView(MainWindow* win, ActionLookup lookup) {
    auto* app = win->gpuiWin->app;
    for (auto entity : gNoteActionViews)
        if (entity.Get(app)->win == win) return entity;
    if (lookup == ActionLookup::Existing) return {};
    auto entity = gp::EntityNewState<NotesActionsView>(app);
    entity.Get(app)->win = win;
    VecAppend(gNoteActionViews, entity);
    return entity;
}
static NotesActionsView* Actions(MainWindow* win) {
    return ActionView(win, ActionLookup::Existing).Get(win->gpuiWin->app);
}
void HideContextNoteActions(MainWindow* win) {
    auto* view = Actions(win);
    if (!view || len(view->id) == 0) return;
    str::Free(view->id);
    view->id = {};
    AppShellInvalidate(win);
}
void DestroyContextNoteActions(MainWindow* win) {
    auto entity = ActionView(win, ActionLookup::Existing);
    if (!entity.IsValid()) return;
    for (int i = 0; i < len(gNoteActionViews); i++) {
        if (gNoteActionViews[i].id == entity.id) {
            VecRemoveAt(gNoteActionViews, i);
            break;
        }
    }
    gp::EntityDrop(win->gpuiWin->app, entity.id);
}
void ShowContextNoteActions(MainWindow* win, Str id, Point anchor) {
    auto* model = win->AsFixed();
    if (!model || win->InPresentation()) return;
    auto* view = ActionView(win, ActionLookup::Create).Get(win->gpuiWin->app);
    if (str::Eq(view->id, id)) return;
    str::ReplaceWithCopy(&view->id, id);
    view->anchor = anchor;
    view->tab = win->CurrentTab();
    view->model = model;
    view->scroll = model->GetScrollState();
    view->viewport = model->GetViewPort();
    view->zoom = model->GetZoomVirtual();
    view->rotation = model->GetRotation();
    view->bounds = {};
    AppShellInvalidate(win);
}
bool ContextNoteActionsNear(MainWindow* win, Point point) {
    auto* view = Actions(win);
    if (!view || len(view->id) == 0) return false;
    float scale = CanvasScale(win);
    float x = point.x * scale + win->canvasRc.x;
    float y = point.y * scale + win->canvasRc.y;
    float ax = view->anchor.x * scale + win->canvasRc.x;
    float ay = view->anchor.y * scale + win->canvasRc.y;
    const float padding = 8;
    const auto& b = view->bounds;
    if (b.w <= 0) return std::abs(x - ax) < 24 && std::abs(y - ay) < 24;
    float left = std::min(b.x, ax) - padding;
    float top = std::min(b.y, ay) - padding;
    float right = std::max(b.x + b.w, ax) + padding;
    float bottom = std::max(b.y + b.h, ay) + padding;
    return x >= left && x <= right && y >= top && y <= bottom;
}
void ContextNotesActionsTick(MainWindow* win) {
    auto* view = Actions(win);
    if (!view || len(view->id) == 0) return;
    auto* model = win->AsFixed();
    bool moved = model != view->model || view->tab != win->CurrentTab() || !model ||
                 !(model->GetScrollState() == view->scroll) || !(model->GetViewPort() == view->viewport) ||
                 model->GetZoomVirtual() != view->zoom || model->GetRotation() != view->rotation;
    Point mouse((int)win->gpuiWin->mouseX, (int)win->gpuiWin->mouseY);
    if (moved || ReflowDocumentVisible(win) || win->InPresentation() || !win->canvasRc.Contains(mouse))
        HideContextNoteActions(win);
}
enum class NotesPopupAction {
    Speak,
    Delete
};
struct NotesPopupTask {
    MainWindow* win;
    HWND frame;
    Str id;
    NotesPopupAction action;
};
static void RunNotesPopup(NotesPopupTask* task) {
    if (IsMainWindowValid(task->win) && NotesFrame(task->win) == task->frame) {
        if (task->action == NotesPopupAction::Speak)
            ContextNoteSpeak(task->win, task->id);
        else
            ContextNoteDelete(task->win, task->id);
    }
    str::Free(task->id);
    delete task;
}
void NotesActionsView::Action(NotesActionsView* self, gp::Ctx*, const gp::ClickEvent*, int64_t action) {
    if (len(self->id) == 0) return;
    auto* task = new NotesPopupTask{self->win, NotesFrame(self->win), str::Dup(self->id), (NotesPopupAction)action};
    uitask::Post(MkFunc0(RunNotesPopup, task), "ContextNoteAction");
}
gp::El* ContextNotesActionsBuild(MainWindow* win, gp::Ctx* cx) {
    auto entity = ActionView(win, ActionLookup::Existing);
    auto* view = entity.Get(cx);
    if (!view || len(view->id) == 0) return nullptr;
    const auto& theme = gp::ThemeNow(cx->app);
    auto* card = gp::Div(cx->a)
                     ->FlexRow()
                     ->ItemsCenter()
                     ->Gap(2)
                     ->Pad(3)
                     ->Radius(5)
                     ->Bg(theme.tokens.popover)
                     ->Border(1, theme.border);
    const char* icons[] = {gIconSpeak, gIconTrash};
    const Str labels[] = {Tr("Read Aloud"), Tr("Delete annotation")};
    for (int i = 0; i < 2; i++) {
        auto* icon = gpc::Icon::Empty(cx)->Data(ToGpui(Str(icons[i])));
        auto* button = gpc::Button::New(cx, GpuiDup(cx->a, i == 0 ? StrL("note-play") : StrL("note-delete")))
                           ->Ghost()
                           ->Compact()
                           ->WithSize(gp::UiSize::Small)
                           ->Icon(gpc::ButtonIcon::New(cx, icon))
                           ->Tooltip(GpuiDup(cx->a, labels[i]))
                           ->OnClick(gp::ListenTo(entity, &NotesActionsView::Action, (int64_t)i));
        card->Child(gp::Div(cx->a)->W(32)->H(32)->Child(button->IntoEl()));
    }
    float width = view->bounds.w > 0 ? view->bounds.w : 74;
    float height = view->bounds.h > 0 ? view->bounds.h : 40;
    float scale = CanvasScale(win);
    float x = std::max(0.f, std::min(view->anchor.x * scale - width / 2, win->canvasRc.dx - width));
    float y = view->anchor.y * scale - height - 10;
    if (y < 0) y = view->anchor.y * scale + 18;
    y = std::max(0.f, std::min(y, win->canvasRc.dy - height));
    card->Absolute()->Left(x)->Top(y)->BoundsOut(&view->bounds);
    return card;
}
TempStr ContextNotesActionsStateTemp(MainWindow* win) {
    auto* view = Actions(win);
    if (!view || len(view->id) == 0) return StrL(" noteActions=0");
    auto b = view->bounds;
    return fmt(" noteActions=1 noteActionRect=%d,%d,%d,%d", (int)b.x, (int)b.y, (int)b.w, (int)b.h);
}

TempStr ContextNoteActionIdTemp(MainWindow* win) {
    auto* view = Actions(win);
    return view ? str::DupTemp(view->id) : TempStr{};
}
