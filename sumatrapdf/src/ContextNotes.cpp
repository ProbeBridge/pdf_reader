/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/File.h"
#include "base/Win.h"
#include "base/JsonParser.h"
#include "base/Crypto.h"
#include "base/UITask.h"
#include <wincrypt.h>
#include <commdlg.h>
#include <time.h>
#include "gui/Dpi.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/win/WebView.h"
#include "gui/Gfx.h"
#include "Settings.h"
#include "AppSettings.h"
#include "AppTools.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "TextSelection.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "AIChatTypes.h"
#include "WindowTab.h"
#include "Selection.h"
#include "FileHistory.h"
#include "Commands.h"
#include "HomePage.h"
#include "Canvas.h"
#include "ContextNoteOverlay.h"
#include "ContextNotesNetwork.h"
#include "ReflowDocument.h"
#include "ContextNotes.h"

constexpr UINT_PTR kContextClickTimer = 172;
constexpr UINT kContextClickDelay = 520;
constexpr int kNotesStoreMaxBytes = 64 * 1024 * 1024;
static StrVec gStoreKeys;
static StrVec gStoreValues;
static bool gStoreLoaded = false;
static bool gStoreFailed = false;
static u64 gNoteDocumentEpoch = 0;

enum class NotesStoreLoad {
    Cached,
    Refresh
};

struct NotesStoreGuard {
    HANDLE mutex = nullptr;
    bool locked = false;

    NotesStoreGuard() {
        Str path = GetPathInAppDataDirTemp(StrL("context-notes.dat"));
        u8 digest[16];
        CalcMD5Digest(str::ToLowerInPlace(str::DupTemp(path)), digest);
        Str name = fmt("Local\\SumatraPDF-AI-%s", str::MemToHexTemp(Str((char*)digest, sizeof(digest))));
        mutex = CreateMutexW(nullptr, FALSE, CWStrTemp(name));
        if (mutex) {
            DWORD wait = WaitForSingleObject(mutex, 5000);
            locked = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
        }
    }

    void Unlock() {
        if (locked) {
            ReleaseMutex(mutex);
            locked = false;
        }
    }

    ~NotesStoreGuard() {
        Unlock();
        if (mutex) {
            CloseHandle(mutex);
        }
    }
};

struct NoteRange {
    Str id;
    Str ipa;
    int page = 0;
    int start = 0;
    int end = 0;
};

struct NotesView : WebviewWnd {
    MainWindow* win = nullptr;
    bool history = false;
    bool ready = false;
};

struct NoteInkPage {
    int page = 0;
    Str source;
    PageText ink;

    ~NoteInkPage() {
        str::Free(source);
        FreePageText(&ink);
    }
};

struct ContextNotes {
    NotesView* panel = nullptr;
    NotesView* history = nullptr;
    bool visible = false;
    bool clickEnabled = true;
    bool wantSettings = false;
    Str documentPath;
    Str documentKey;
    StrVec pendingSelections;
    Str positions;
    Vec<NoteRange> ranges;
    Vec<int> pendingText;
    Vec<int> completedText;
    Vec<NoteInkPage*> inkPages;
    u64 documentEpoch = 0;
    Point clickPoint;
    WindowTab* clickTab = nullptr;
    DisplayModel* documentModel = nullptr;
    ScrollState clickScroll;
    float clickZoom = 0;
    int clickPage = 0;
    PointF clickPagePoint;
    Rect clickViewport;
    int clickRotation = 0;
    DWORD lastPositions = 0;
};

static TempStr JsonQuote(Str s) {
    return fmt("\"%s\"", json::EscapeStrTemp(s));
}

static TempStr JsonField(Str data, Str key) {
    Str segment = str::JoinTemp(StrL("/"), key);
    json::Reader r(data);
    for (json::Value& v : r) {
        if (json::PathMatch(v.path, segment)) {
            return str::DupTemp(v.value);
        }
    }
    return {};
}

static TempStr StorePath() {
    return GetPathInAppDataDirTemp(StrL("context-notes.dat"));
}

static void LoadNotesStore(NotesStoreLoad mode = NotesStoreLoad::Cached) {
    if (gStoreLoaded && (mode == NotesStoreLoad::Cached || gDontSaveSettings)) {
        return;
    }
    gStoreLoaded = true;
    gStoreFailed = false;
    Str path = StorePath();
    if (!file::Exists(path)) {
        gStoreKeys.Reset();
        gStoreValues.Reset();
        return;
    }
    if (file::GetSize(path) > kNotesStoreMaxBytes) {
        gStoreFailed = true;
        return;
    }
    Str bytes = file::ReadFile(path);
    AutoFree<char> freeBytes(bytes.s);
    DATA_BLOB input{(DWORD)len(bytes), (BYTE*)bytes.s};
    DATA_BLOB output{};
    if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
        gStoreFailed = true;
        return;
    }
    StrVec keys;
    StrVec values;
    json::Reader r(Str((char*)output.pbData, (int)output.cbData));
    for (json::Value& v : r) {
        if (!v.path || v.path->next || v.type != json::Type::String) {
            continue;
        }
        keys.Append(json::PathSegKey(v.path));
        values.Append(v.value);
    }
    gStoreFailed = !r.Ok();
    if (!gStoreFailed) {
        gStoreKeys = keys;
        gStoreValues = values;
    }
    LocalFree(output.pbData);
}

static bool SaveNotesStore() {
    str::Builder b;
    b.AppendChar('{');
    for (int i = 0; i < len(gStoreKeys); i++) {
        if (i) {
            b.AppendChar(',');
        }
        b.Append(fmt("%s:%s", JsonQuote(gStoreKeys[i]), JsonQuote(gStoreValues[i])));
        if (len(b) > kNotesStoreMaxBytes - 4096) {
            return false;
        }
    }
    b.AppendChar('}');
    Str data = ToStr(b);
    if (gDontSaveSettings) {
        return true;
    }
    DATA_BLOB input{(DWORD)len(data), (BYTE*)data.s};
    DATA_BLOB output{};
    if (!CryptProtectData(&input, L"SumatraPDF AI notes", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN,
                          &output)) {
        return false;
    }
    TempStr path = StorePath();
    TempStr tmp = fmt("%s.%d.tmp", path, (int)GetCurrentProcessId());
    bool ok =
        output.cbData <= kNotesStoreMaxBytes && file::WriteFile(tmp, Str((char*)output.pbData, (int)output.cbData));
    LocalFree(output.pbData);
    if (ok) {
        file::FileHandle handle = file::OpenReadWrite(tmp, false);
        ok = handle != file::kInvalidFileHandle && file::Flush(handle);
        if (handle != file::kInvalidFileHandle) {
            file::Close(handle);
        }
    }
    if (ok) {
        ok =
            MoveFileExW(ToWStrTemp(tmp).s, ToWStrTemp(path).s, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
    }
    return ok;
}

static TempStr ReadNotesStore() {
    str::Builder b;
    b.AppendChar('{');
    for (int i = 0; i < len(gStoreKeys); i++) {
        if (i) {
            b.AppendChar(',');
        }
        b.Append(fmt("%s:%s", JsonQuote(gStoreKeys[i]), gStoreValues[i]));
    }
    b.AppendChar('}');
    return ToStrTemp(b);
}

static void DispatchNotes(NotesView* view, Str name, Str json) {
    if (view && view->ready) {
        view->Eval(fmt("window.dispatchEvent(new CustomEvent(%s,{detail:%s}))", JsonQuote(name), json));
    }
}

void EmitContextNotesNetwork(MainWindow* win, Str payloadJson) {
    if (win && win->contextNotes) {
        DispatchNotes(win->contextNotes->panel, StrL("netevent"), payloadJson);
    }
}

static void BroadcastStore(Str key, Str value) {
    Str change = fmt("{%s:{newValue:%s}}", JsonQuote(key), value);
    for (MainWindow* win : gWindows) {
        if (win->contextNotes) {
            DispatchNotes(win->contextNotes->panel, StrL("storechange"), change);
        }
    }
}

static TempStr NotesAssetPath() {
    WCHAR exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe, dimof(exe));
    Str dir = path::GetDirTemp(ToUtf8Temp(WStr(exe)));
    Str assets = path::JoinTemp(dir, StrL("notes"));
    if (path::IsDirectory(assets)) {
        return str::DupTemp(assets);
    }
    dir = path::GetDirTemp(path::GetDirTemp(dir));
    return path::JoinTemp(dir, StrL("src\\notes"));
}

static bool NotesResource(void*, Str resource, WebViewResourceResult* res) {
    while (len(resource) > 0 && resource.s[0] == '/') {
        resource = Str(resource.s + 1, len(resource) - 1);
    }
    if (len(resource) == 0) {
        resource = StrL("index.html");
    }
    if (str::Contains(resource, StrL("..")) || str::Contains(resource, StrL(":")) ||
        str::Contains(resource, StrL("\\")) || str::Contains(resource, StrL("%"))) {
        return false;
    }
    Str data = file::ReadFile(path::JoinTemp(NotesAssetPath(), resource));
    if (len(data) == 0) {
        return false;
    }
    res->data = (const u8*)data.s;
    res->dataLen = len(data);
    Str type = StrL("application/octet-stream");
    if (str::EndsWithI(resource, StrL(".html"))) {
        type = StrL("text/html; charset=utf-8");
    } else if (str::EndsWithI(resource, StrL(".js")) || str::EndsWithI(resource, StrL(".mjs"))) {
        type = StrL("text/javascript; charset=utf-8");
    } else if (str::EndsWithI(resource, StrL(".css"))) {
        type = StrL("text/css; charset=utf-8");
    } else if (str::EndsWithI(resource, StrL(".json"))) {
        type = StrL("application/json");
    } else if (str::EndsWithI(resource, StrL(".wasm"))) {
        type = StrL("application/wasm");
    }
    res->contentType = str::Dup(type);
    return true;
}

static TempStr NotesDocument(MainWindow* win) {
    auto* n = win->contextNotes;
    WindowTab* tab = win->CurrentTab();
    Str path = tab && tab->ctrl ? tab->filePath : Str{};
    Str title = len(path) > 0 ? path::GetBaseNameTemp(path) : Str{};
    return fmt("{\"key\":%s,\"path\":%s,\"title\":%s}", JsonQuote(n->documentKey), JsonQuote(path), JsonQuote(title));
}

static TempStr DocumentNotesKey(Str path) {
    if (len(path) == 0) {
        return {};
    }
    file::Mapping map;
    if (file::MemoryMap(path, &map)) {
        if (map.size > 0 && map.size <= INT_MAX) {
            u8 digest[32];
            CalcSHA2Digest(Str((char*)map.data, (int)map.size), digest);
            file::MemoryUnmap(&map);
            return str::JoinTemp(StrL("sha256:"), str::MemToHexTemp(Str((char*)digest, sizeof(digest))));
        }
        file::MemoryUnmap(&map);
    }
    return str::ToLowerInPlace(str::DupTemp(path::NormalizeTemp(path)));
}

static TempStr NotesSelection(MainWindow* win) {
    DisplayModel* dm = win->AsFixed();
    if (!dm || !win->showSelection) {
        return {};
    }
    bool isText = false;
    Str quote = GetSelectedTextTemp(win->CurrentTab(), StrL("\n"), isText);
    if (len(quote) == 0 || !isText) {
        return {};
    }
    int fromPage, fromGlyph, toPage, toGlyph;
    dm->textSelection->GetGlyphRange(&fromPage, &fromGlyph, &toPage, &toGlyph);
    str::Builder ranges;
    str::Builder context;
    ranges.AppendChar('[');
    for (int page = fromPage; page <= toPage; page++) {
        int count = 0;
        Str all = dm->GetEngine()->GetTextForPage(page, &count);
        int start = page == fromPage ? fromGlyph : 0;
        int end = page == toPage ? toGlyph : count;
        if (page != fromPage) {
            ranges.AppendChar(',');
            context.AppendChar('\n');
        }
        ranges.Append(fmt("{\"page\":%d,\"start\":%d,\"end\":%d}", page, start, end));
        // PDF paragraphs have wrapped lines; keep neighboring lines as context.
        int contextStart = std::max(0, start - 1200);
        int contextEnd = std::min(count, end + 1200);
        context.Append(Utf8SliceByCodepoints(all, contextStart, contextEnd - contextStart));
    }
    ranges.AppendChar(']');
    auto* n = win->contextNotes;
    return fmt("{\"key\":%s,\"path\":%s,\"title\":%s,\"quote\":%s,\"context\":%s,\"ranges\":%s}",
               JsonQuote(n->documentKey), JsonQuote(n->documentPath), JsonQuote(path::GetBaseNameTemp(n->documentPath)),
               JsonQuote(quote), JsonQuote(ToStr(context)), ToStr(ranges));
}

static void ClearNoteRanges(ContextNotes* n) {
    for (NoteRange& r : n->ranges) {
        str::Free(r.id);
        str::Free(r.ipa);
    }
    VecReset(n->ranges);
    VecReset(n->completedText);
}

static void ClearNoteInk(ContextNotes* n) {
    for (NoteInkPage* page : n->inkPages) delete page;
    VecReset(n->inkPages);
}

static NoteInkPage* FindNoteInk(ContextNotes* n, int page) {
    for (NoteInkPage* entry : n->inkPages) {
        if (entry->page == page) return entry;
    }
    return nullptr;
}

static void SetNoteRanges(ContextNotes* n, Str items) {
    ClearNoteRanges(n);
    json::Reader reader(items);
    int previous = -1;
    for (json::Value& v : reader) {
        int idx = json::PathSegIndex(v.path);
        if (idx < 0 || idx > 50000 || !v.path->next) {
            continue;
        }
        if (idx != previous) {
            VecAppend(n->ranges, NoteRange{});
            previous = idx;
        }
        NoteRange& r = VecLast(n->ranges);
        Str key = json::PathSegKey(v.path->next);
        int number = v.type == json::Type::Number && len(v.value) > 0 ? atoi(CStrTemp(v.value)) : 0;
        if (str::Eq(key, StrL("id"))) {
            str::ReplaceWithCopy(&r.id, v.value);
        } else if (str::Eq(key, StrL("ipa"))) {
            str::ReplaceWithCopy(&r.ipa, v.value);
        } else if (str::Eq(key, StrL("page"))) {
            r.page = number;
        } else if (str::Eq(key, StrL("start"))) {
            r.start = number;
        } else if (str::Eq(key, StrL("end"))) {
            r.end = number;
        }
    }
}

static TempStr ReadingHistoryJson() {
    str::Builder b;
    b.AppendChar('[');
    auto* states = FileHistoryStates();
    bool first = true;
    if (states && SettingsRememberOpenedFiles()) {
        for (FileState* fs : *states) {
            if (!fs || fs->isMissing || len(fs->filePath) == 0) {
                continue;
            }
            if (!first) {
                b.AppendChar(',');
            }
            first = false;
            i64 opened = len(fs->lastOpened) > 0 ? _atoi64(CStrTemp(fs->lastOpened)) : 0;
            b.Append(fmt("{\"path\":%s,\"name\":%s,\"opened\":%lld}", JsonQuote(fs->filePath),
                         JsonQuote(path::GetBaseNameTemp(fs->filePath)), opened));
        }
    }
    b.AppendChar(']');
    return ToStrTemp(b);
}

static void GoToNote(MainWindow* win, Str id) {
    if (ReflowDocumentGoToNote(win, id)) {
        return;
    }
    auto* n = win->contextNotes;
    auto* dm = win->AsFixed();
    if (!dm) {
        return;
    }
    for (NoteRange& r : n->ranges) {
        if (!str::Eq(r.id, id) || !dm->ValidPageNo(r.page)) {
            continue;
        }
        Rect* coords = nullptr;
        int count = 0;
        dm->GetEngine()->GetTextForPage(r.page, &count, &coords);
        if (r.start >= 0 && r.start < count) {
            RectF rect = ToRectF(coords[r.start]);
            dm->ScrollTo(r.page, rect, 0);
        } else {
            dm->GoToPage(r.page, true);
        }
        ScheduleRepaint(win, 0);
        break;
    }
}

static bool SaveNotesExport(MainWindow* win, Str value) {
    WCHAR file[MAX_PATH] = L"SumatraPDF-notes.json";
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = win->hwndFrame;
    ofn.lpstrFilter = L"JSON files\0*.json\0\0";
    ofn.lpstrFile = file;
    ofn.nMaxFile = dimof(file);
    ofn.lpstrDefExt = L"json";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    Str copy = str::Dup(value);
    AutoFree<char> freeCopy(copy.s);
    return GetSaveFileNameW(&ofn) && file::WriteFile(ToUtf8Temp(WStr(file)), copy);
}

static void NotesCall(void* ctx, Str id, Str method, Str params) {
    auto* view = (NotesView*)ctx;
    MainWindow* win = view->win;
    auto* n = win->contextNotes;
    if (!str::Eq(method, StrL("notes"))) {
        view->Resolve(id, 1, JsonQuote(StrL("Unknown method")));
        return;
    }
    Str data;
    json::Reader args(params);
    for (json::Value& v : args) {
        if (json::PathMatch(v.path, StrL("i0")) && v.type == json::Type::String) {
            data = v.value;
        }
    }
    Str action = JsonField(data, StrL("action"));
    Str result = StrL("true");
    int error = 0;
    if (str::Eq(action, StrL("ready"))) {
        view->ready = true;
        n->clickEnabled = str::Eq(JsonField(data, StrL("click")), StrL("true"));
        Str queued = str::JoinTemp(StrL("["), JoinTemp(&n->pendingSelections, StrL(",")), StrL("]"));
        result = fmt("{\"document\":%s,\"selections\":%s,\"settings\":%s,\"network\":true}", NotesDocument(win), queued,
                     n->wantSettings ? StrL("true") : StrL("false"));
        n->pendingSelections.Reset();
        n->wantSettings = false;
    } else if (str::Eq(action, StrL("fetch"))) {
        StartContextNotesFetch(win, JsonField(data, StrL("id")), data);
    } else if (str::Eq(action, StrL("cancelFetch"))) {
        CancelContextNotesFetch(win, JsonField(data, StrL("id")));
    } else if (str::Eq(action, StrL("history"))) {
        view->ready = true;
        result = ReadingHistoryJson();
    } else if (str::Eq(action, StrL("read"))) {
        NotesStoreGuard guard;
        if (guard.locked) {
            LoadNotesStore(NotesStoreLoad::Refresh);
        }
        error = gStoreFailed || !guard.locked ? 1 : 0;
        result = error ? JsonQuote(StrL("Cannot read encrypted notes. The original file has been preserved."))
                       : ReadNotesStore();
    } else if (str::Eq(action, StrL("write")) || str::Eq(action, StrL("remove"))) {
        NotesStoreGuard guard;
        if (guard.locked) {
            LoadNotesStore(NotesStoreLoad::Refresh);
        }
        Str key = JsonField(data, StrL("key"));
        Str value = JsonField(data, StrL("value"));
        Str expected = JsonField(data, StrL("expected"));
        int idx = gStoreKeys.Find(key);
        Str previous = idx >= 0 ? gStoreValues[idx] : StrL("null");
        if (gStoreFailed || !guard.locked || len(key) == 0 || len(key) > 4096 || len(value) > kNotesStoreMaxBytes) {
            error = 1;
            result = JsonQuote(StrL("Cannot save notes. Existing data has been preserved."));
        } else if (len(expected) > 0 && !str::Eq(previous, expected)) {
            result = StrL("{\"conflict\":true}");
        } else {
            Str old = idx >= 0 ? str::Dup(gStoreValues[idx]) : Str{};
            AutoFree<char> freeOld(old.s);
            if (str::Eq(action, StrL("remove"))) {
                if (idx >= 0) {
                    gStoreKeys.RemoveAt(idx);
                    gStoreValues.RemoveAt(idx);
                }
            } else if (idx >= 0) {
                gStoreValues.SetAt(idx, value);
            } else {
                gStoreKeys.Append(key);
                gStoreValues.Append(value);
            }
            if (!SaveNotesStore()) {
                int current = gStoreKeys.Find(key);
                if (current >= 0) {
                    gStoreKeys.RemoveAt(current);
                    gStoreValues.RemoveAt(current);
                }
                if (len(old) > 0) {
                    gStoreKeys.Append(key);
                    gStoreValues.Append(old);
                }
                error = 1;
                result = JsonQuote(StrL("Could not save notes to disk."));
            } else {
                guard.Unlock();
                BroadcastStore(key, len(value) > 0 ? value : StrL("null"));
            }
        }
    } else if (str::Eq(action, StrL("preferences"))) {
        n->clickEnabled = str::Eq(JsonField(data, StrL("click")), StrL("true"));
        ReflowDocumentUpdateNotes(win);
    } else if (str::Eq(action, StrL("highlights"))) {
        if (str::Eq(JsonField(data, StrL("key")), n->documentKey)) {
            SetNoteRanges(n, JsonField(data, StrL("items")));
            ReflowDocumentUpdateNotes(win);
            ScheduleRepaint(win, 0);
        }
    } else if (str::Eq(action, StrL("goto"))) {
        if (str::Eq(JsonField(data, StrL("key")), n->documentKey)) {
            GoToNote(win, JsonField(data, StrL("id")));
        }
    } else if (str::Eq(action, StrL("copy"))) {
        result = CopyTextToClipboard(JsonField(data, StrL("value"))) ? StrL("true") : StrL("false");
    } else if (str::Eq(action, StrL("export"))) {
        result = SaveNotesExport(win, JsonField(data, StrL("value"))) ? StrL("true") : StrL("false");
    } else if (str::Eq(action, StrL("closeNotes"))) {
        n->visible = false;
        win->uiState.layout = {};
        ScheduleUiUpdate(win, kUiForceRelayout);
    } else if (str::Eq(action, StrL("showNotes"))) {
        if (!n->visible) {
            ToggleContextNotes(win);
        }
    } else if (str::Eq(action, StrL("openPicker"))) {
        HwndPostCommand(win->hwndFrame, CmdOpenFile);
    } else if (str::Eq(action, StrL("open"))) {
        Str path = JsonField(data, StrL("path"));
        if (FileHistoryFindByPath(path)) {
            LoadDocument(win, path);
        }
    } else if (str::Eq(action, StrL("hideHistory")) || str::Eq(action, StrL("restoreHistory"))) {
        FileState* fs = FileHistoryFindByPath(JsonField(data, StrL("path")));
        if (fs) {
            fs->isMissing = str::Eq(action, StrL("hideHistory"));
            HomePageInvalidateLayoutCache();
            ScheduleSaveSettings();
            for (MainWindow* window : gWindows) {
                if (window->contextNotes) {
                    DispatchNotes(window->contextNotes->history, StrL("historychange"), StrL("null"));
                }
            }
        }
    } else {
        error = 1;
        result = JsonQuote(StrL("Unknown notes action"));
    }
    if (VecContains(gWindows, win)) {
        view->Resolve(id, error, result);
    }
}

static bool NotesNavigation(void*, Str url, bool) {
    if (len(url) > 0 && url.s[0] == '/') {
        url = Str(url.s + 1, len(url) - 1);
    }
    return str::Eq(url, StrL("index.html")) || str::Eq(url, StrL("history.html"));
}

static int NotesAccel(void* ctx, u16 vk, bool ctrl, bool shift, bool alt) {
    auto* view = (NotesView*)ctx;
    if (ctrl && !shift && !alt && vk == 'H') {
        return CmdReadingHistory;
    }
    if (ctrl && shift && vk == 'A') {
        return CmdContextNotes;
    }
    if (alt && shift && vk == 'A') {
        return CmdContextAnnotate;
    }
    if (ctrl && vk == 'O') {
        return CmdOpenFile;
    }
    if (ctrl && !shift && vk == 'F' && view->history) {
        return 0;
    }
    return 0;
}

static ContextNotes* EnsureNotes(MainWindow* win) {
    if (!win->contextNotes) {
        win->contextNotes = new ContextNotes();
        LoadNotesStore();
        int idx = gStoreKeys.Find(StrL("settings"));
        if (idx >= 0 && str::Eq(JsonField(gStoreValues[idx], StrL("clickToAnnotate")), StrL("false"))) {
            win->contextNotes->clickEnabled = false;
        }
    }
    return win->contextNotes;
}

static NotesView* CreateNotesView(MainWindow* win, bool history) {
    if (!HasWebView()) {
        MessageBoxW(win->hwndFrame, L"AI notes require Microsoft Edge WebView2 Runtime.", L"SumatraPDF AI", MB_OK);
        return nullptr;
    }
    auto* view = new NotesView();
    view->win = win;
    view->history = history;
    view->dataDir = str::Dup(GetWebViewDataDirTemp());
    view->resourceUriPrefix = wstr::Dup(WStrL(L"https://sumatra-notes/"));
    view->resourceProvider = {nullptr, NotesResource};
    view->events.ctx = view;
    view->events.jsCall = NotesCall;
    view->events.navigationStarting = NotesNavigation;
    view->events.resolveAccelCmd = NotesAccel;
    view->allowClipboardRead = false;
    view->allowExternalDrop = false;
    view->defaultBackgroundColor = MkRgb(255, 255, 255);
    CreateWebViewArgs args;
    args.parent = history ? win->hwndCanvas : win->hwndFrame;
    args.pos = HwndClientRect(args.parent);
    if (!view->Create(args)) {
        delete view;
        return nullptr;
    }
    view->Bind(StrL("notes"));
    view->Navigate(history ? StrL("https://sumatra-notes/history.html") : StrL("https://sumatra-notes/index.html"));
    view->SetIsVisible(true);
    return view;
}

void ContextNotesSync(MainWindow* win) {
    auto* n = EnsureNotes(win);
    WindowTab* tab = win->CurrentTab();
    Str path = tab && tab->ctrl ? tab->filePath : Str{};
    DisplayModel* model = win->AsFixed();
    if (!str::EqI(path, n->documentPath) || model != n->documentModel) {
        ContextNotesCancelClick(win);
        n->documentModel = model;
        n->documentEpoch = ++gNoteDocumentEpoch;
        VecReset(n->pendingText);
        LoadNotesStore(NotesStoreLoad::Refresh);
        ClearNoteInk(n);
        ClearNoteRanges(n);
        str::ReplaceWithCopy(&n->documentPath, path);
        str::ReplaceWithCopy(&n->documentKey, DocumentNotesKey(path));
        int idx = gStoreKeys.Find(str::JoinTemp(StrL("page:"), n->documentKey));
        if (idx >= 0 && str::Contains(gStoreValues[idx], StrL("\"annotations\":[{")) && !n->panel) {
            n->panel = CreateNotesView(win, false);
            n->visible = n->panel != nullptr;
            win->uiState.layout = {};
        }
        DispatchNotes(n->panel, StrL("documentchange"), NotesDocument(win));
        DispatchNotes(n->history, StrL("historychange"), StrL("null"));
    }
    if (n->history) {
        n->history->SetIsVisible(win->IsCurrentTabAbout() && !win->InPresentation());
    }
}

bool ContextNotesHome(MainWindow* win) {
    auto* n = EnsureNotes(win);
    if (!HasWebView()) {
        return false;
    }
    if (!n->history) {
        n->history = CreateNotesView(win, true);
    }
    if (!n->history) {
        return false;
    }
    HomePageHideSearch(win);
    n->history->SetIsVisible(true);
    Rect rc = HwndClientRect(win->hwndCanvas);
    HwndMoveWindow(n->history->hwnd, &rc);
    return true;
}

void ContextNotesLayout(MainWindow* win) {
    auto* n = win->contextNotes;
    if (!n) {
        return;
    }
    if (n->history && n->history->IsVisible()) {
        Rect rc = HwndClientRect(win->hwndCanvas);
        HwndMoveWindow(n->history->hwnd, &rc);
    }
    if (n->panel) {
        n->panel->SetIsVisible(ContextNotesVisible(win));
    }
}

HWND ContextNotesHwnd(MainWindow* win) {
    return win->contextNotes && win->contextNotes->panel ? win->contextNotes->panel->hwnd : nullptr;
}

bool ContextNotesVisible(MainWindow* win) {
    return win->contextNotes && win->contextNotes->visible && !win->InPresentation() &&
           !(win->CurrentTab() && win->CurrentTab()->IsFavoritesTab());
}

void ToggleContextNotes(MainWindow* win) {
    auto* n = EnsureNotes(win);
    if (!n->panel) {
        n->panel = CreateNotesView(win, false);
        if (!n->panel) {
            return;
        }
    }
    ContextNotesSync(win);
    n->visible = !n->visible;
    win->uiState.layout = {};
    ScheduleUiUpdate(win, kUiForceRelayout);
}

void ShowContextSettings(MainWindow* win) {
    auto* n = EnsureNotes(win);
    if (!n->visible) {
        ToggleContextNotes(win);
    }
    if (n->panel && n->panel->ready) {
        DispatchNotes(n->panel, StrL("showsettings"), StrL("null"));
    } else {
        n->wantSettings = true;
    }
}

void ShowReadingHistory(MainWindow* win) {
    HwndSendCommand(win->hwndFrame, CmdNewTab);
    ContextNotesHome(win);
}

void AnnotateContextSelection(MainWindow* win) {
    auto* dm = win->AsFixed();
    if (!dm || !HasPermission(Perm::CopySelection) || !dm->GetEngine()->allowsCopyingText) {
        return;
    }
    auto* n = EnsureNotes(win);
    ContextNotesSync(win);
    Str selection = NotesSelection(win);
    if (len(selection) == 0) {
        if (!n->visible) {
            ToggleContextNotes(win);
        }
        return;
    }
    n->pendingSelections.Append(selection);
    if (!n->visible) {
        ToggleContextNotes(win);
    }
    if (n->panel && n->panel->ready) {
        for (Str pending : n->pendingSelections) {
            DispatchNotes(n->panel, StrL("annotate"), pending);
        }
        n->pendingSelections.Reset();
    }
}

TempStr ContextNotesReflowState(MainWindow* win) {
    ContextNotesSync(win);
    auto* n = win->contextNotes;
    str::Builder ranges;
    ranges.AppendChar('[');
    bool first = true;
    for (NoteRange& range : n->ranges) {
        if (!first) ranges.AppendChar(',');
        first = false;
        ranges.Append(fmt("{\"id\":%s,\"ipa\":%s,\"page\":%d,\"start\":%d,\"end\":%d}", JsonQuote(range.id),
                          JsonQuote(range.ipa), range.page, range.start, range.end));
    }
    ranges.AppendChar(']');
    auto* dm = win->AsFixed();
    bool click = n->clickEnabled && dm && HasPermission(Perm::CopySelection) && dm->GetEngine()->allowsCopyingText;
    return fmt("{\"document\":%s,\"click\":%s,\"highlights\":%s}", NotesDocument(win),
               click ? StrL("true") : StrL("false"), ToStr(ranges));
}

static bool ValidReflowRanges(DisplayModel* dm, Str ranges) {
    if (len(ranges) < 2 || ranges.s[0] != '[' || ranges.s[len(ranges) - 1] != ']') return false;
    int previous = -1;
    int page = 0, start = -1, end = -1, fields = 0;
    auto validRange = [&]() {
        if (fields != 7 || !dm->ValidPageNo(page) || start < 0 || end <= start) return false;
        EngineBase* engine = dm->GetEngine();
        if (!engine->HasTextForPage(page)) return false;
        int count = 0;
        return engine->TryGetTextForPage(page, &count) && end <= count;
    };
    json::Reader reader(ranges);
    for (json::Value& value : reader) {
        if (!value.path || !value.path->next || value.path->next->next || value.type != json::Type::Number)
            return false;
        int idx = json::PathSegIndex(value.path);
        if (idx < 0 || idx >= 64) return false;
        if (idx != previous) {
            if (idx != previous + 1 || (previous >= 0 && !validRange())) return false;
            previous = idx;
            page = 0;
            start = end = -1;
            fields = 0;
        }
        if (len(value.value) == 0 || len(value.value) > 9) return false;
        for (int pos = 0; pos < len(value.value); pos++) {
            char c = value.value.s[pos];
            if (c < '0' || c > '9') return false;
        }
        int number = atoi(CStrTemp(value.value));
        Str key = json::PathSegKey(value.path->next);
        int field = 0;
        if (str::Eq(key, StrL("page"))) {
            page = number;
            field = 1;
        } else if (str::Eq(key, StrL("start"))) {
            start = number;
            field = 2;
        } else if (str::Eq(key, StrL("end"))) {
            end = number;
            field = 4;
        } else {
            return false;
        }
        if (fields & field) return false;
        fields |= field;
    }
    return reader.Ok() && previous >= 0 && validRange();
}

bool AnnotateContextReflow(MainWindow* win, Str quote, Str context, Str rangesJson) {
    auto* dm = win->AsFixed();
    if (!dm || !HasPermission(Perm::CopySelection) || !dm->GetEngine()->allowsCopyingText || len(quote) == 0 ||
        !ValidReflowRanges(dm, rangesJson))
        return false;
    ContextNotesSync(win);
    auto* n = win->contextNotes;
    n->pendingSelections.Append(fmt("{\"key\":%s,\"path\":%s,\"title\":%s,\"quote\":%s,\"context\":%s,\"ranges\":%s}",
                                    JsonQuote(n->documentKey), JsonQuote(n->documentPath),
                                    JsonQuote(path::GetBaseNameTemp(n->documentPath)), JsonQuote(quote),
                                    JsonQuote(context), rangesJson));
    if (!n->visible) ToggleContextNotes(win);
    if (n->panel && n->panel->ready) {
        for (Str pending : n->pendingSelections) DispatchNotes(n->panel, StrL("annotate"), pending);
        n->pendingSelections.Reset();
    }
    return true;
}

void ContextNotesReflowPositions(MainWindow* win, Str positionsJson) {
    if (!win->contextNotes) return;
    json::Reader reader(positionsJson);
    for (json::Value& value : reader) {
        (void)value;
    }
    if (reader.Ok()) DispatchNotes(win->contextNotes->panel, StrL("notepositions"), positionsJson);
}

void ContextNotesReflowFocus(MainWindow* win, Str id) {
    auto* n = win->contextNotes;
    if (!n) return;
    for (NoteRange& range : n->ranges) {
        if (!str::Eq(range.id, id)) continue;
        if (!n->visible) ToggleContextNotes(win);
        DispatchNotes(n->panel, StrL("focusnote"), fmt("{\"id\":%s}", JsonQuote(id)));
        return;
    }
}

struct NotesTextTask {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    EngineBase* engine = nullptr;
    u64 epoch = 0;
    int page = 0;
    Str source;
    PageText ink;

    ~NotesTextTask() {
        str::Free(source);
        FreePageText(&ink);
    }
};

static void FinishNotesText(NotesTextTask* task) {
    if (IsMainWindowValid(task->win) && task->win->hwndFrame == task->frame) {
        auto* n = task->win->contextNotes;
        auto* dm = task->win->AsFixed();
        if (n && dm && n->documentEpoch == task->epoch && dm->GetEngine() == task->engine) {
            VecRemove(n->pendingText, task->page);
            if (!task->engine->HasTextForPage(task->page)) VecAppend(n->completedText, task->page);
            if (NoteInkPage* old = FindNoteInk(n, task->page)) {
                VecRemove(n->inkPages, old);
                delete old;
            }
            constexpr int kNoteInkCachePages = 32;
            if (len(n->inkPages) >= kNoteInkCachePages) {
                delete n->inkPages[0];
                VecRemoveAt(n->inkPages, 0);
            }
            auto* entry = new NoteInkPage();
            entry->page = task->page;
            entry->source = task->source;
            task->source = {};
            entry->ink = task->ink;
            task->ink = {};
            VecAppend(n->inkPages, entry);
            ScheduleRepaint(task->win, 0);
        }
    }
    task->engine->Release();
    delete task;
}

static void LoadNotesText(NotesTextTask* task) {
    task->source = str::Dup(task->engine->GetTextForPage(task->page));
    task->ink = task->engine->ExtractPageInkText(task->page);
    if (!str::Eq(task->source, task->ink.text)) FreePageText(&task->ink);
    task->engine->ReleaseTextExtractionThreadContext();
    uitask::Post(MkFunc0(FinishNotesText, task), "ContextNotesText");
}

static bool NotesTextCached(MainWindow* win, DisplayModel* dm, int page) {
    EngineBase* engine = dm->GetEngine();
    auto* n = win->contextNotes;
    bool cached = engine->HasTextForPage(page);
    NoteInkPage* ink = FindNoteInk(n, page);
    if (cached && ink && str::Eq(ink->source, engine->GetTextForPage(page))) return true;
    if (VecContains(n->completedText, page)) return cached;
    if (VecContains(n->pendingText, page) || VecContains(n->completedText, page)) return false;
    VecAppend(n->pendingText, page);
    auto* task = new NotesTextTask();
    task->win = win;
    task->frame = win->hwndFrame;
    task->engine = engine;
    task->epoch = n->documentEpoch;
    task->page = page;
    engine->AddRef();
    ThreadHandle thread = StartThread(MkFunc0(LoadNotesText, task), StrL("ContextNotesText"));
    if (!thread) {
        VecRemove(n->pendingText, page);
        VecAppend(n->completedText, page);
        engine->Release();
        delete task;
    } else {
        SafeCloseThreadHandle(&thread);
    }
    return false;
}

void PaintContextNotes(MainWindow* win, Gfx* gfx) {
    if (ReflowDocumentVisible(win)) return;
    auto* n = win->contextNotes;
    DisplayModel* dm = win->AsFixed();
    if (!n || !dm) {
        return;
    }
    str::Builder positions;
    positions.AppendChar('[');
    bool first = true;
    for (NoteRange& r : n->ranges) {
        if (!dm->ValidPageNo(r.page) || !dm->PageVisible(r.page)) {
            continue;
        }
        if (!NotesTextCached(win, dm, r.page)) continue;
        int count = 0;
        Rect* coords = nullptr;
        if (!dm->GetEngine()->TryGetTextForPage(r.page, &count, &coords) || !coords) {
            continue;
        }
        int start = limitValue(r.start, 0, count);
        int end = limitValue(r.end, start, count);
        NoteInkPage* ink = FindNoteInk(n, r.page);
        bool accurate = ink && ink->ink.coords && ink->ink.nCodepoints == count;
        Rect* highlightCoords = accurate ? ink->ink.coords : coords;
        Vec<TextSel> selection;
        FillSelectionRects(&selection, r.page, highlightCoords, count, start, end - start,
                           ToRect(dm->GetEngine()->PageMediabox(r.page)));
        int top = INT_MAX;
        for (TextSel& sel : selection) {
            Rect rect = dm->CvtToScreen(r.page, ToRectF(sel.rect));
            if (!accurate) {
                int inset = rect.dy / 6;
                rect.y += inset;
                rect.dy -= inset * 2;
            }
            gfx->FillRects(&rect, 1, MkRgb(255, 219, 112), 75);
            gfx->DrawLine(Rect(rect.x, rect.y + rect.dy, rect.dx, 1), MkRgb(153, 84, 0), DpiScale(1));
            top = std::min(top, rect.y);
        }
        if (top != INT_MAX) {
            if (!first) {
                positions.AppendChar(',');
            }
            first = false;
            positions.Append(fmt("{\"id\":%s,\"y\":%d}", JsonQuote(r.id), MulDiv(top, 96, DpiGet())));
        }
    }
    positions.AppendChar(']');
    if (ContextNotesVisible(win) && GetTickCount() - n->lastPositions >= 80 &&
        !str::Eq(ToStr(positions), n->positions)) {
        n->lastPositions = GetTickCount();
        str::ReplaceWithCopy(&n->positions, ToStr(positions));
        DispatchNotes(n->panel, StrL("notepositions"), n->positions);
    }
}

void ContextNotesCancelClick(MainWindow* win) {
    HideContextNoteActions(win);
    KillTimer(win->hwndCanvas, kContextClickTimer);
    if (win->contextNotes) {
        win->contextNotes->clickTab = nullptr;
    }
}

void ContextNoteDelete(MainWindow* win, Str id) {
    auto* n = win->contextNotes;
    if (!n) {
        return;
    }
    HideContextNoteActions(win);
    for (NoteRange& range : n->ranges) {
        if (str::Eq(range.id, id)) {
            DispatchNotes(n->panel, StrL("deletenote"),
                          fmt("{\"key\":%s,\"id\":%s}", JsonQuote(n->documentKey), JsonQuote(id)));
            return;
        }
    }
}

bool ContextNotesHover(MainWindow* win, Point point) {
    auto* n = win->contextNotes;
    auto* dm = win->AsFixed();
    if (!n || !dm || len(n->ranges) == 0) {
        return false;
    }
    int page = dm->GetPageNoByPoint(point);
    if (!dm->ValidPageNo(page)) {
        return false;
    }
    bool hasRange = false;
    for (NoteRange& range : n->ranges) {
        if (range.page == page) {
            hasRange = true;
            break;
        }
    }
    if (!hasRange || !NotesTextCached(win, dm, page)) return false;
    int count = 0;
    Rect* coords = nullptr;
    if (!dm->GetEngine()->TryGetTextForPage(page, &count, &coords) || !coords) {
        return false;
    }
    PointF pagePoint = dm->CvtFromScreen(point, page);
    for (NoteRange& range : n->ranges) {
        if (range.page != page) {
            continue;
        }
        for (int glyph = std::max(0, range.start); glyph < std::min(count, range.end); glyph++) {
            if (!ToRectF(coords[glyph]).Contains(pagePoint)) {
                continue;
            }
            if (len(range.ipa) > 0) {
                Rect rect = dm->CvtToScreen(page, ToRectF(coords[glyph]));
                win->ShowToolTip(range.ipa, rect);
            } else {
                win->DeleteToolTip();
            }
            SetCursorCached(IDC_HAND);
            return true;
        }
    }
    return false;
}

static void CALLBACK NotesClickTimer(HWND canvas, UINT, UINT_PTR, DWORD) {
    KillTimer(canvas, kContextClickTimer);
    MainWindow* win = nullptr;
    for (MainWindow* window : gWindows) {
        if (window->hwndCanvas == canvas) {
            win = window;
            break;
        }
    }
    if (!win || !win->contextNotes || win->CurrentTab() != win->contextNotes->clickTab) {
        return;
    }
    auto* n = win->contextNotes;
    auto* dm = win->AsFixed();
    if (!dm || win->mouseAction != MouseAction::None || !HasPermission(Perm::CopySelection) ||
        !dm->GetEngine()->allowsCopyingText || !(dm->GetScrollState() == n->clickScroll) ||
        dm->GetZoomVirtual() != n->clickZoom || !(dm->GetViewPort() == n->clickViewport) ||
        dm->GetRotation() != n->clickRotation) {
        return;
    }
    int page = n->clickPage;
    if (!dm->ValidPageNo(page)) {
        return;
    }
    PointF point = n->clickPagePoint;
    for (NoteRange& range : n->ranges) {
        if (range.page != page) {
            continue;
        }
        int count = 0;
        Rect* coords = nullptr;
        dm->GetEngine()->GetTextForPage(page, &count, &coords);
        for (int i = std::max(range.start, 0); i < std::min(range.end, count); i++) {
            if (ToRectF(coords[i]).Contains(point)) {
                Str id = str::DupTemp(range.id);
                if (!n->visible) {
                    ToggleContextNotes(win);
                }
                DispatchNotes(n->panel, StrL("focusnote"), fmt("{\"id\":%s}", JsonQuote(id)));
                ShowContextNoteActions(win, id, n->clickPoint);
                return;
            }
        }
    }
    if (!n->clickEnabled || !dm->textSelection->IsOverGlyph(page, point.x, point.y)) {
        return;
    }
    dm->textSelection->SelectWordAt(page, point.x, point.y);
    Str quote = dm->textSelection->ExtractTextTemp(StrL("\n"));
    bool latin = false;
    for (int i = 0; i < len(quote); i++) {
        if ((quote.s[i] >= 'A' && quote.s[i] <= 'Z') || (quote.s[i] >= 'a' && quote.s[i] <= 'z')) {
            latin = true;
        }
    }
    if (!latin) {
        dm->textSelection->Reset();
        return;
    }
    UpdateTextSelection(win, false);
    AnnotateContextSelection(win);
    // The auto-selected word is already captured; leave the next click for its note actions.
    DeleteOldSelectionInfo(win, true);
    ScheduleRepaint(win, 0);
}

void ContextNotesClick(MainWindow* win, int x, int y) {
    auto* n = EnsureNotes(win);
    auto* dm = win->AsFixed();
    if (!dm) {
        return;
    }
    n->clickPoint = Point(x, y);
    n->clickTab = win->CurrentTab();
    n->clickScroll = dm->GetScrollState();
    n->clickZoom = dm->GetZoomVirtual();
    n->clickPage = dm->GetPageNoByPoint(n->clickPoint);
    n->clickPagePoint = dm->CvtFromScreen(n->clickPoint, n->clickPage);
    n->clickViewport = dm->GetViewPort();
    n->clickRotation = dm->GetRotation();
    SetTimer(win->hwndCanvas, kContextClickTimer, std::max(kContextClickDelay, GetDoubleClickTime() + 30),
             NotesClickTimer);
}

void ContextNotesDestroy(MainWindow* win) {
    CancelContextNotesFetches(win);
    DestroyContextNoteActions(win);
    auto* n = win->contextNotes;
    if (!n) {
        return;
    }
    ContextNotesCancelClick(win);
    NotesView* panel = n->panel;
    NotesView* history = n->history;
    n->panel = nullptr;
    n->history = nullptr;
    delete panel;
    delete history;
    ClearNoteRanges(n);
    ClearNoteInk(n);
    str::Free(n->documentPath);
    str::Free(n->documentKey);
    str::Free(n->positions);
    delete n;
    win->contextNotes = nullptr;
}
