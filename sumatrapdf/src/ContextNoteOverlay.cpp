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
    Func1List<MainWindow*> onWindowMoved;
};

static ContextNoteActions* gNoteActions = nullptr;

struct NoteDeleteButton : VirtIconButton {
    Size GetIdealSize() override {
        int side = DpiScale(kNoteActionButtonSize);
        return {side, side};
    }
};

struct NoteDeleteTask {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    Str id;
};

static void DeleteNoteTask(NoteDeleteTask* task) {
    if (IsMainWindowValid(task->win) && task->win->hwndFrame == task->frame) {
        ContextNoteDelete(task->win, task->id);
    }
    str::Free(task->id);
    delete task;
}

static void DeleteClicked(ContextNoteActions* actions, VirtMouseEvent* ev) {
    if (actions != gNoteActions || !IsMainWindowValid(actions->win) || len(actions->id) == 0) {
        return;
    }
    ev->didHandle = true;
    auto* task = new NoteDeleteTask();
    task->win = actions->win;
    task->frame = actions->win->hwndFrame;
    task->id = str::Dup(actions->id);
    HideContextNoteActions(actions->win);
    // The host's click dispatch must finish before deletion can close a window.
    uitask::Post(MkFunc0(DeleteNoteTask, task), "DeleteContextNote");
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
    actions->onWindowMoved = MkFunc1Void(HideContextNoteActions);
    win->RegisterOnWindowMoved(&actions->onWindowMoved);
    gNoteActions = actions;
    return actions;
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
    str::ReplaceWithCopy(&actions->id, id);
    auto* button = new NoteDeleteButton();
    int icon = DpiScale(kNoteActionIconSize);
    button->pixmap =
        GetCachedPixmapForSvg(Str(gIconTrash), icon, icon, ThemeWindowTextColor(), ThemeWindowBackgroundColor());
    button->SetColor(kColIconBtnBgHover, ThemeWindowControlBackgroundColor());
    button->SetTooltip(PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE ? StrL("删除注释")
                                                                                 : StrL("Delete note"));
    button->onClick = MkFunc1(DeleteClicked, actions);
    int padding = DpiScale(kNoteActionPadding);
    Size size = actions->host->SetLayoutSizedToContent(new Padding(button, Insets{padding, padding, padding, padding}));

    Point anchor = HwndClientToScreen(win->hwndCanvas, canvasPoint);
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
