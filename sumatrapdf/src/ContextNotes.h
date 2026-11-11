struct ContextNotes;
struct MainWindow;
struct Gfx;

void ToggleContextNotes(MainWindow* win);
void AnnotateContextSelection(MainWindow* win);
void ShowContextSettings(MainWindow* win);
void ShowReadingHistory(MainWindow* win);
void ContextNotesSync(MainWindow* win);
void ContextNotesLayout(MainWindow* win);
void ContextNotesDestroy(MainWindow* win);
HWND ContextNotesHwnd(MainWindow* win);
bool ContextNotesVisible(MainWindow* win);
bool ContextNotesHome(MainWindow* win);
void PaintContextNotes(MainWindow* win, Gfx* gfx);
void ContextNotesClick(MainWindow* win, int x, int y);
void ContextNotesCancelClick(MainWindow* win);
bool ContextNotesHover(MainWindow* win, Point point);
