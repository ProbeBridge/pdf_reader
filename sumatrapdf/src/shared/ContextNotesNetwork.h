struct MainWindow;

void StartContextNotesFetch(MainWindow* win, Str id, Str requestJson);
void CancelContextNotesFetch(MainWindow* win, Str id);
void CancelContextNotesFetches(MainWindow* win);
void EmitContextNotesNetwork(MainWindow* win, Str payloadJson);
