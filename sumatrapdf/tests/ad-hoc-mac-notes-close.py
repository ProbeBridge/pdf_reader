"""Exercise notes entity cleanup after the native window is gone.

Uses the production cleanup functions with a minimal GPUI entity owner.
Run after a debug build; --source also accepts the source before the fix.
"""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
path = Path(sys.argv[2]) if len(sys.argv) == 3 and sys.argv[1] == '--source' else root / 'src/ng/ContextNotes.cpp'
source = path.read_text()
actions = source[source.index('enum class ActionLookup'):source.index('void ShowContextNoteActions(')]
panel = source[source.index('void NotesPanelDestroy('):source.index('gp::El* ContextNotesPanelBuild(')]
harness = r'''
#include "base/Base.h"
#include <assert.h>
void log(Str) {}
void _uploadDebugReport(Str, Str, bool) { abort(); }
namespace gp {
struct App {};
struct Window { App* app; };
static App app;
static int live = 0;
static void* slots[16]{};
static int serial = 0;
template <class T> struct Entity {
    int id = 0;
    bool IsValid() const { return id != 0; }
    T* Get(App* owner) const { assert(owner == &app); return id ? (T*)slots[id] : nullptr; }
};
template <class T> Entity<T> EntityNewState(App* owner) {
    assert(owner == &app);
    slots[++serial] = new T(); live++;
    return {serial};
}
void EntityDrop(App* owner, int id) {
    assert(owner == &app && slots[id]);
    // The fixture views are empty at cleanup; free without depending on their types.
    ::operator delete(slots[id]); slots[id] = nullptr; live--;
}
}
struct MainWindow { gp::Window* gpuiWin = nullptr; };
struct NotesActionsView { MainWindow* win = nullptr; Str id; };
struct NotesPanelView {};
static Vec<gp::Entity<NotesActionsView>> gNoteActionViews;
static Vec<MainWindow*> gPanelWindows;
static Vec<gp::Entity<NotesPanelView>> gPanelViews;
static gp::App* AppShellGetApp() { return &gp::app; }
static void AppShellInvalidate(MainWindow*) {}
''' + actions + panel + r'''
int main() {
    MainWindow win;
    // This is the state in the reported AppShellReapClosedWindows crash.
    assert(win.gpuiWin == nullptr);
    DestroyContextNoteActions(&win);
    auto action = ActionView(&win, ActionLookup::Create);
    assert(action.IsValid() && gp::live == 1);
    DestroyContextNoteActions(&win);
    assert(len(gNoteActionViews) == 0 && gp::live == 0);
    VecAppend(gPanelWindows, &win);
    VecAppend(gPanelViews, gp::EntityNewState<NotesPanelView>(AppShellGetApp()));
    NotesPanelDestroy(&win);
    assert(len(gPanelWindows) == 0 && len(gPanelViews) == 0 && gp::live == 0);
    DestroyContextNoteActions(&win);
    NotesPanelDestroy(&win);
    puts("PASS missing native window, action/sidebar cleanup and repeated destruction");
}
'''
with tempfile.TemporaryDirectory(prefix='sumatra-close-') as tmp:
    folder = Path(tmp)
    (folder / 'Close.cpp').write_text(harness)
    subprocess.run(['clang++', '-std=c++20', '-I', str(root / 'src'), str(folder / 'Close.cpp'),
                    str(root / 'out/mac/dbg/lib/libbase.a'), '-framework', 'Foundation',
                    '-framework', 'AppKit', '-framework', 'Security', '-framework', 'CoreServices',
                    '-lz', '-liconv', '-o', str(folder / 'test')], check=True)
    subprocess.run([str(folder / 'test')], check=True, timeout=30)
