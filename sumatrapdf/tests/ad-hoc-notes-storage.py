"""Exercise the shared file store with an isolated, fake legacy decryptor.

Run after a debug Mac build: python3 tests/ad-hoc-notes-storage.py
No production data or Keychain item is accessed.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'src/shared/ContextNotesCommon.cpp').read_text()
store = source[source.index('static TempStr StorePath()'):source.index('static TempStr ReadNotesStore()')]
quote = source[source.index('static TempStr JsonQuote('):source.index('static TempStr JsonField(')]
with tempfile.TemporaryDirectory(prefix='sumatra-store-') as tmp:
    folder = Path(tmp)
    harness = r'''
#include "base/Base.h"
#include "base/File.h"
#include "base/JsonParser.h"
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <assert.h>
void log(Str) {}
void _uploadDebugReport(Str, Str, bool) { abort(); }
static Str testDir;
static bool gDontSaveSettings = false;
static bool gForTesting = false;
static constexpr int kNotesStoreMaxBytes = 64 * 1024 * 1024;
static StrVec gStoreKeys, gStoreValues;
static bool gStoreLoaded = false, gStoreFailed = false;
static bool gLegacyReadFailed = false;
enum class NotesStoreLoad { Cached, Refresh };
static int decrypts = 0;
TempStr GetPathInAppDataDirTemp(Str name) { return path::JoinTemp(testDir, name); }
int CurrentProcessId() { return (int)getpid(); }
Str NotesEncrypt(Str plain) { return str::Dup(str::JoinTemp(StrL("LEGACY:"), plain)); }
Str NotesDecrypt(Str bytes) {
    decrypts++;
    return str::StartsWith(bytes, StrL("LEGACY:")) ? str::Dup(Str(bytes.s + 7, len(bytes) - 7)) : Str{};
}
''' + quote + store + r'''
int main(int argc, char** argv) {
    assert(argc == 2);
    testDir = Str(argv[1]);
    gStoreKeys.Append(StrL("settings"));
    gStoreValues.Append(StrL("{\"apiKey\":\"LOCAL_STORE_TEST_ONLY\"}"));
    gStoreKeys.Append(StrL("page:test"));
    gStoreValues.Append(StrL("{\"annotations\":[{\"quote\":\"portable 中文\"}]}"));
    assert(SaveNotesStore());
    Str disk = file::ReadFile(StorePath());
    assert(len(disk) && disk.s[0] == '{' && "The store must be plain JSON");
    assert(str::Contains(disk, StrL("LOCAL_STORE_TEST_ONLY")));
    struct stat info{};
    assert(stat(CStrTemp(StorePath()), &info) == 0 && (info.st_mode & 0777) == 0600);
    gStoreKeys.Reset(); gStoreValues.Reset();
    LoadNotesStore(NotesStoreLoad::Refresh);
    assert(!gStoreFailed && len(gStoreKeys) == 2 && decrypts == 0);
    assert(str::Contains(gStoreValues[1], StrL("portable 中文")));
    puts("PASS plain JSON, API key, Unicode, restart load and private file permissions without Keychain");
    Str legacy = NotesEncrypt(disk);
    assert(file::WriteFile(StorePath(), legacy));
    LoadNotesStore(NotesStoreLoad::Refresh);
    assert(!gStoreFailed && decrypts == 1);
    Str migrated = file::ReadFile(StorePath());
    assert(str::Eq(disk, migrated));
    Str backup = file::ReadFile(str::JoinTemp(StorePath(), StrL(".encrypted.bak")));
    assert(str::Eq(legacy, backup));
    LoadNotesStore(NotesStoreLoad::Refresh);
    assert(!gStoreFailed && decrypts == 1);
    puts("PASS legacy migration preserves all records and exact backup; later reads never decrypt");
    Str tempPath = fmt("%s.%d.tmp", StorePath(), CurrentProcessId());
    assert(mkdir(CStrTemp(tempPath), 0700) == 0);
    assert(file::WriteFile(StorePath(), legacy));
    LoadNotesStore(NotesStoreLoad::Refresh);
    assert(gStoreFailed && decrypts == 2);
    Str untouched = file::ReadFile(StorePath());
    assert(str::Eq(untouched, legacy));
    LoadNotesStore(NotesStoreLoad::Refresh);
    assert(gStoreFailed && decrypts == 2);
    assert(rmdir(CStrTemp(tempPath)) == 0);
    puts("PASS failed migration leaves the original intact and never repeats authorization in the process");
    for (Str bad : {StrL("{\"settings\":1}"), StrL("{\"settings\":\"oops\""), StrL("{\"x\":\"a\",\"x\":\"b\"}")}) {
        assert(file::WriteFile(StorePath(), bad));
        LoadNotesStore(NotesStoreLoad::Refresh);
        assert(gStoreFailed && decrypts == 2);
        Str unchanged = file::ReadFile(StorePath());
        assert(str::Eq(unchanged, bad));
        str::Free(unchanged);
    }
    puts("PASS malformed JSON, wrong field types and duplicates are preserved without Keychain access");
    str::Free(disk);
    str::Free(legacy); str::Free(migrated); str::Free(backup); str::Free(untouched);
}
'''
    (folder / 'Store.cpp').write_text(harness)
    subprocess.run([
        'clang++', '-std=c++20', '-I', str(root / 'src'),
        str(folder / 'Store.cpp'), str(root / 'out/mac/dbg/lib/libbase.a'),
        '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'Security',
        '-framework', 'CoreServices', '-lz', '-liconv', '-o', str(folder / 'test'),
    ], check=True)
    subprocess.run([str(folder / 'test'), str(folder)], check=True, timeout=30)
