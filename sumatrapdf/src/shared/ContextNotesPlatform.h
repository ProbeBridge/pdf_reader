struct MainWindow;
TempStr NotesAssetsTemp();
#if defined(SUMATRA_NG)
#include "NotesPlatform.h"
#else
inline HWND NotesFrame(MainWindow* win) {
    return win->hwndFrame;
}
inline HWND NotesCanvas(MainWindow* win) {
    return win->hwndCanvas;
}
inline void NotesRelayout(MainWindow* win) {
    win->uiState.layout = {};
}
inline void NotesUpdate(MainWindow* win) {
    ScheduleUiUpdate(win, kUiForceRelayout | kUiToolbarDirty);
}
inline bool NotesCopy(MainWindow*, Str text) {
    return CopyTextToClipboard(text);
}
inline void NotesPostCommand(MainWindow* win, int cmd) {
    HwndPostCommand(win->hwndFrame, cmd);
}
inline void NotesExecute(MainWindow* win, int cmd) {
    HwndSendCommand(win->hwndFrame, cmd);
}
#if defined(CONTEXT_NOTES_IMPL)
inline void NotesPaintRect(Gfx* gfx, Rect rc) {
    gfx->FillRects(&rc, 1, MkRgb(255, 219, 112), 75);
    gfx->DrawLine(Rect(rc.x, rc.y + rc.dy, rc.dx, 1), MkRgb(153, 84, 0), DpiScale(1));
}
inline void NotesTooltip(MainWindow* win, Str text, Rect rc) {
    if (text)
        win->ShowToolTip(text, rc);
    else
        win->DeleteToolTip();
}
inline Point NotesCursorPoint(MainWindow* win) {
    return HwndGetCursorPos(win->hwndCanvas);
}
inline void NotesHandCursor(MainWindow*) {
    SetCursorCached(IDC_HAND);
}
#endif
void NotesStartTimer(MainWindow* win);
void NotesCancelTimer(MainWindow* win);
#endif
