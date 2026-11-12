/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/Win.h"
#include "base/UITask.h"
#include "gui/Dpi.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/GuiColors.h"
#include "gui/VirtCtrl.h"
#include "gui/VirtHost.h"
#include "Settings.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "SvgIcons.h"
#include "Theme.h"
#include "ContextNoteOverlay.h"

constexpr int kNoteActionIconSize = 22;
constexpr int kNoteActionButtonSize = 32;
constexpr int kNoteActionPadding = 3;
constexpr int kNoteActionGap = 10;
constexpr int kNoteActionRadius = 5;

struct ContextNoteActions {
    MainWindow* win = nullptr;
    VirtHost* host = nullptr;
    Str id;
    Point anchor;
    Func1List<MainWindow*> onWindowMoved;
};

static ContextNoteActions* gNoteActions = nullptr;

struct NoteActionButton : VirtIconButton {
    Size GetIdealSize() override {
        int side = DpiScale(kNoteActionButtonSize);
        return {side, side};
    }
};

enum class NoteAction {
    Speak,
    Delete
};

struct NoteActionTask {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    Str id;
    NoteAction action = NoteAction::Delete;
};

static void RunNoteAction(NoteActionTask* task) {
    if (IsMainWindowValid(task->win) && task->win->hwndFrame == task->frame) {
        if (task->action == NoteAction::Speak) {
            ContextNoteSpeak(task->win, task->id);
        } else {
            ContextNoteDelete(task->win, task->id);
        }
    }
    str::Free(task->id);
    delete task;
}

static void QueueNoteAction(ContextNoteActions* actions, VirtMouseEvent* ev, NoteAction action) {
    if (actions != gNoteActions || !IsMainWindowValid(actions->win) || len(actions->id) == 0) {
        return;
    }
    ev->didHandle = true;
    auto* task = new NoteActionTask();
    task->win = actions->win;
    task->frame = actions->win->hwndFrame;
    task->id = str::Dup(actions->id);
    task->action = action;
    if (action == NoteAction::Delete) {
        HideContextNoteActions(actions->win);
    }
    // The host's click dispatch must finish before an action can relayout a window.
    uitask::Post(MkFunc0(RunNoteAction, task), "ContextNoteAction");
}

static void DeleteClicked(ContextNoteActions* actions, VirtMouseEvent* ev) {
    QueueNoteAction(actions, ev, NoteAction::Delete);
}

static void SpeakClicked(ContextNoteActions* actions, VirtMouseEvent* ev) {
    QueueNoteAction(actions, ev, NoteAction::Speak);
}

static void ActionsMouseLeave(ContextNoteActions* actions) {
    if (actions != gNoteActions || !IsMainWindowValid(actions->win)) {
        return;
    }
    Point point = HwndScreenToClient(actions->win->hwndCanvas, UiCursorScreenPos());
    if (!ContextNoteActionsNear(actions->win, point)) {
        HideContextNoteActions(actions->win);
    }
}

static void PaintActionBg(ContextNoteActions*, VirtHostPaintEvent* ev) {
    ev->gfx->FillRoundedRect(ev->clientRect, DpiScale(kNoteActionRadius), ThemeWindowBackgroundColor(),
                             ThemeWindowTextColor());
}

static void ActionNativeMessage(ContextNoteActions* actions, VirtHostNativeMsg* ev) {
    if (ev->msg == WM_KEYDOWN && ev->wp == VK_ESCAPE) {
        HideContextNoteActions(actions->win);
        ev->didHandle = true;
        return;
    }
    if (ev->msg == WM_MOUSEWHEEL || ev->msg == WM_MOUSEHWHEEL) {
        MainWindow* win = actions->win;
        HideContextNoteActions(win);
        if (IsMainWindowValid(win)) {
            PostMessageW(win->hwndCanvas, ev->msg, ev->wp, ev->lp);
        }
        ev->didHandle = true;
    }
}

static ContextNoteActions* EnsureActions(MainWindow* win) {
    if (gNoteActions && gNoteActions->win != win) {
        DestroyContextNoteActions(gNoteActions->win);
    }
    if (gNoteActions) {
        return gNoteActions;
    }
    auto* actions = new ContextNoteActions();
    actions->win = win;
    VirtHost::CreateArgs args;
    args.parent = win->hwndFrame;
    args.className = WStrL(L"SumatraContextNoteActions");
    args.isPopup = true;
    args.noActivate = true;
    args.visible = false;
    args.userData = actions;
    actions->host = VirtHost::Create(args);
    if (!actions->host) {
        delete actions;
        return nullptr;
    }
    actions->host->onPaintBackground = MkFunc1(PaintActionBg, actions);
    actions->host->onNativeMsg = MkFunc1(ActionNativeMessage, actions);
    actions->host->onMouseLeave = MkFunc0(ActionsMouseLeave, actions);
    actions->onWindowMoved = MkFunc1Void(HideContextNoteActions);
    win->RegisterOnWindowMoved(&actions->onWindowMoved);
    gNoteActions = actions;
    return actions;
}

static NoteActionButton* NewNoteActionButton(Str svg, Str tooltip, Func1<VirtMouseEvent*> onClick) {
    auto* button = new NoteActionButton();
    int icon = DpiScale(kNoteActionIconSize);
    button->pixmap = GetCachedPixmapForSvg(svg, icon, icon, ThemeWindowTextColor(), ThemeWindowBackgroundColor());
    button->SetColor(kColIconBtnBgHover, ThemeWindowControlBackgroundColor());
    button->SetTooltip(tooltip);
    button->onClick = onClick;
    return button;
}

void ShowContextNoteActions(MainWindow* win, Str id, Point canvasPoint) {
    if (!IsMainWindowValid(win) || len(id) == 0 || win->InPresentation()) {
        return;
    }
    DpiSetFromHwnd(win->hwndCanvas);
    ContextNoteActions* actions = EnsureActions(win);
    if (!actions) {
        return;
    }
    if (actions->host->IsVisible() && str::Eq(actions->id, id)) {
        return;
    }
    str::ReplaceWithCopy(&actions->id, id);
    bool chinese = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
    auto* row = new HBox();
    row->gap = DpiScale(kNoteActionPadding);
    row->AddChild(NewNoteActionButton(Str(gIconSpeak), chinese ? StrL("朗读原文") : StrL("Read original text"),
                                      MkFunc1(SpeakClicked, actions)));
    row->AddChild(NewNoteActionButton(Str(gIconTrash), chinese ? StrL("删除注释") : StrL("Delete note"),
                                      MkFunc1(DeleteClicked, actions)));
    int padding = DpiScale(kNoteActionPadding);
    Size size = actions->host->SetLayoutSizedToContent(new Padding(row, Insets{padding, padding, padding, padding}));

    Point anchor = HwndClientToScreen(win->hwndCanvas, canvasPoint);
    actions->anchor = anchor;
    Rect canvas = HwndClientRect(win->hwndCanvas);
    int x = limitValue(canvasPoint.x - size.dx / 2, 0, std::max(0, canvas.dx - size.dx));
    Point at = HwndClientToScreen(win->hwndCanvas, Point(x, canvasPoint.y));
    Rect placed(at.x, anchor.y - DpiScale(kNoteActionGap) - size.dy, size.dx, size.dy);
    MONITORINFO monitor{sizeof(monitor)};
    if (GetMonitorInfoW(MonitorFromWindow(win->hwndFrame, MONITOR_DEFAULTTONEAREST), &monitor)) {
        placed.y = std::max(placed.y, (int)monitor.rcWork.top);
        if (placed.Contains(anchor)) {
            placed.x = std::min(anchor.x + DpiScale(kNoteActionGap), (int)monitor.rcWork.right - size.dx);
        }
    }
    actions->host->SetPos(placed, true);
    actions->host->ClipToRoundedRect(kNoteActionRadius, size);
    actions->host->Repaint();
}

bool ContextNoteActionsNear(MainWindow* win, Point canvasPoint) {
    ContextNoteActions* actions = gNoteActions;
    if (!actions || actions->win != win || !actions->host->IsVisible()) {
        return false;
    }
    Rect corridor = actions->host->ScreenRect().Union(Rect(actions->anchor, Size(1, 1)));
    int padding = DpiScale(kNoteActionPadding);
    corridor.Inflate(padding, padding);
    return corridor.Contains(HwndClientToScreen(win->hwndCanvas, canvasPoint));
}

void HideContextNoteActions(MainWindow* win) {
    ContextNoteActions* actions = gNoteActions;
    if (!actions || actions->win != win) {
        return;
    }
    str::FreePtr(&actions->id);
    actions->host->Show(false);
}

void DestroyContextNoteActions(MainWindow* win) {
    ContextNoteActions* actions = gNoteActions;
    if (!actions || actions->win != win) {
        return;
    }
    gNoteActions = nullptr;
    win->UnregisterOnWindowMoved(&actions->onWindowMoved);
    str::Free(actions->id);
    delete actions->host;
    delete actions;
}

TempStr ContextNoteActionIdTemp(MainWindow* win) {
    return gNoteActions && gNoteActions->win == win ? str::DupTemp(gNoteActions->id) : TempStr{};
}
