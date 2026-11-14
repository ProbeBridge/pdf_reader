"""Test the legacy Mac decoder with a fake Keychain; never access real keys."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'src/ng/NotesStorage_mac.mm').read_text()
assert 'SecItemAdd' not in source, 'The legacy decoder must never create keys'
fake = r'''
static int reads = 0;
static OSStatus TestKeyCopyMatching(CFDictionaryRef, CFTypeRef* result) {
    reads++;
    unsigned char key[64];
    for (int i = 0; i < 64; i++) key[i] = (unsigned char)i;
    *result = CFDataCreate(nullptr, key, 64);
    return errSecSuccess;
}
#define SecItemCopyMatching TestKeyCopyMatching
'''
source = source.replace('static constexpr char kNotesMagic', fake + '\nstatic constexpr char kNotesMagic')
main = r'''
void* AllocZero(int n, int bytes) { return calloc(n, bytes); }
int main(int argc, char** argv) {
    const char* text = "{\"settings\":\"legacy-test-only\",\"page:test\":\"portable\"}";
    if (NotesDecrypt(StrL("{\"settings\":\"plain\"}")).len || reads) return 1;
    unsigned char key[64];
    for (int i = 0; i < 64; i++) key[i] = (unsigned char)i;
    char storage[4096]{};
    int header = sizeof(kNotesMagic) - 1;
    memcpy(storage, kNotesMagic, header);
    size_t used = 0;
    if (CCCrypt(kCCEncrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key, 32,
                storage + header, text, strlen(text), storage + header + 16,
                sizeof(storage) - header - 16 - 32, &used) != kCCSuccess) return 2;
    int n = header + 16 + (int)used;
    CCHmac(kCCHmacAlgSHA256, key + 32, 32, storage, n, storage + n);
    n += 32;
    if (argc > 1) {
        FILE* file = fopen(argv[1], "rb");
        if (!file) return 3;
        n = (int)fread(storage, 1, sizeof(storage), file);
        fclose(file);
    }
    Str cipher(storage, n);
    Str plain = NotesDecrypt(cipher);
    if (len(plain) != (int)strlen(text) || memcmp(plain.s, text, len(plain))) return 4;
    free(plain.s);
    for (int i = 0; i < n; i++) {
        storage[i] ^= 1;
        if (len(NotesDecrypt(cipher))) return 5;
        storage[i] ^= 1;
    }
    FILE* file = fopen("legacy.dat", "wb");
    fwrite(storage, 1, n, file);
    fclose(file);
    puts("PASS legacy AES/HMAC decoding and tamper rejection with no real Keychain access");
}
'''
with tempfile.TemporaryDirectory(prefix='sumatra-legacy-') as tmp:
    folder = Path(tmp)
    (folder / 'Test.mm').write_text(source + main)
    subprocess.run(['clang++', '-std=c++20', '-I', str(root / 'src'),
                    str(folder / 'Test.mm'), '-framework', 'Security',
                    '-framework', 'Foundation', '-o', str(folder / 'test')], check=True)
    subprocess.run([str(folder / 'test')], cwd=folder, check=True, timeout=30)
    subprocess.run([str(folder / 'test'), str(folder / 'legacy.dat')], cwd=folder, check=True, timeout=30)
