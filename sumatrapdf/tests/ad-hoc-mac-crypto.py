from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
service=f'org.probebridge.SumatraPDF-AI.notes.test.{os.getpid()}'
with tempfile.TemporaryDirectory(prefix='sumatra-crypto-') as tmp:
 p=Path(tmp)
 s=(root/'src/ng/NotesStorage_mac.mm').read_text().replace('org.probebridge.SumatraPDF-AI.notes',service)
 (p/'Storage.mm').write_text(s)
 (p/'Test.cpp').write_text(r'''
#include "base/Base.h"
void* AllocZero(int n, int bytes) { return calloc(n, bytes); }
Str NotesEncrypt(Str);
Str NotesDecrypt(Str);
int main(int argc, char** argv) {
    const char* text = "{\"settings\":\"test-secret\",\"page:test\":\"portable\"}";
    Str cipher;
    if (argc > 1) {
        FILE* f = fopen(argv[1], "rb");
        if (!f) return 10;
        char buf[4096]; int n = fread(buf, 1, sizeof(buf), f); fclose(f);
        cipher = Str(buf,n);
        Str plain = NotesDecrypt(cipher);
        bool ok = plain.len == (int)strlen(text) && !memcmp(plain.s,text,plain.len);
        free(plain.s);
        return ok ? 0 : 11;
    }
    cipher = NotesEncrypt(Str((char*)text));
    if (!cipher.len) return 1;
    Str plain = NotesDecrypt(cipher);
    if (plain.len != (int)strlen(text) || memcmp(plain.s,text,plain.len)) return 2;
    free(plain.s);
    Str other = NotesEncrypt(Str((char*)text));
    if (cipher.len != other.len || !memcmp(cipher.s,other.s,cipher.len)) return 3;
    free(other.s);
    for (int i=0;i<cipher.len;i++) {
        cipher.s[i] ^= 1;
        Str invalid = NotesDecrypt(cipher);
        if (invalid.len) return 4;
        cipher.s[i] ^= 1;
    }
    FILE* f = fopen("encrypted.dat","wb");
    fwrite(cipher.s,1,cipher.len,f);fclose(f);free(cipher.s);
    puts("PASS Keychain encryption, randomized IV and tamper rejection");
}
''')
 try:
  subprocess.run(['clang++','-std=c++20','-I',str(root/'src'),str(p/'Test.cpp'),str(p/'Storage.mm'),'-framework','Security','-framework','Foundation','-o',str(p/'test')],check=True)
  subprocess.run(['codesign','--force','--sign','-',str(p/'test')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  subprocess.run([str(p/'test')],cwd=p,check=True,timeout=30)
  subprocess.run([str(p/'test'),str(p/'encrypted.dat')],cwd=p,check=True,timeout=30)
  print('PASS decrypt after process restart')
 finally:
  subprocess.run(['security','delete-generic-password','-s',service,'-a','notes-key-v1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
