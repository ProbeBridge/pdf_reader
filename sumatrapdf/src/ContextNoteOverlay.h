struct MainWindow;

void ShowContextNoteActions(MainWindow* win, Str id, Point canvasPoint);
bool ContextNoteActionsNear(MainWindow* win, Point canvasPoint);
TempStr ContextNoteActionIdTemp(MainWindow* win);
void HideContextNoteActions(MainWindow* win);
void DestroyContextNoteActions(MainWindow* win);
void ContextNoteDelete(MainWindow* win, Str id);
void ContextNoteSpeak(MainWindow* win, Str id);
