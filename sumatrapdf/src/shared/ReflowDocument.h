/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

struct MainWindow;

bool ReflowDocumentAvailable(MainWindow*);
bool ReflowDocumentVisible(MainWindow*);
void ReflowDocumentLayout(MainWindow*);
void ReflowDocumentDestroy(MainWindow*);
bool ReflowDocumentHandleCommand(MainWindow*, int cmdId);
bool ReflowDocumentZoomBy(MainWindow*, float factor);
int ReflowDocumentZoom(MainWindow*);
void ReflowDocumentUpdateNotes(MainWindow*);
bool ReflowDocumentGoToNote(MainWindow*, Str id);

// ContextNotes owns the document identity and notes store. The reflow content
// receives only this narrow, view-specific state, never credentials/settings.
TempStr ContextNotesReflowState(MainWindow*);
bool AnnotateContextReflow(MainWindow*, Str quote, Str context, Str rangesJson);
void ContextNotesReflowPositions(MainWindow*, Str positionsJson);
void ContextNotesReflowFocus(MainWindow*, Str id);
