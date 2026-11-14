/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */
#include "base/Base.h"
#include "base/MacTypesHide.h"
#define BOOL MacObjcBool
#include <Security/Security.h>
#undef BOOL
#include "base/MacTypesShow.h"
#include <CommonCrypto/CommonCryptor.h>
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonDigest.h>

static constexpr char kNotesMagic[] = "SPAI-MAC-1";
static constexpr int kKeyBytes = 64;
static constexpr int kIvBytes = kCCBlockSizeAES128;
static constexpr int kMacBytes = CC_SHA256_DIGEST_LENGTH;

// Read-only compatibility for the former encrypted store; new writes use JSON.
static CFMutableDictionaryRef KeyQuery() {
    auto q = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(q, kSecAttrService, CFSTR("org.probebridge.SumatraPDF-AI.notes"));
    CFDictionarySetValue(q, kSecAttrAccount, CFSTR("notes-key-v1"));
    return q;
}
static bool NotesKey(u8 key[kKeyBytes]) {
    auto q = KeyQuery();
    CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
    CFTypeRef result = nullptr;
    OSStatus status = SecItemCopyMatching(q, &result);
    CFRelease(q);
    if (status == errSecSuccess && result) {
        auto data = (CFDataRef)result;
        bool ok = CFDataGetLength(data) == kKeyBytes;
        if (ok) memcpy(key, CFDataGetBytePtr(data), kKeyBytes);
        CFRelease(result);
        return ok;
    }
    return false;
}
Str NotesDecrypt(Str bytes) {
    constexpr int header = sizeof(kNotesMagic) - 1;
    if (len(bytes) < header + kIvBytes + kCCBlockSizeAES128 + kMacBytes || memcmp(bytes.s, kNotesMagic, header))
        return {};
    u8 key[kKeyBytes]{}, mac[kMacBytes]{};
    if (!NotesKey(key)) return {};
    int n = len(bytes) - kMacBytes;
    CCHmac(kCCHmacAlgSHA256, key + kCCKeySizeAES256, kCCKeySizeAES256, bytes.s, n, mac);
    u8 diff = 0;
    for (int i = 0; i < kMacBytes; i++) diff |= mac[i] ^ (u8)bytes.s[n + i];
    auto* out = AllocArray<char>(n + 1);
    size_t used = 0;
    bool ok = diff == 0 &&
              CCCrypt(kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key, kCCKeySizeAES256, bytes.s + header,
                      bytes.s + header + kIvBytes, n - header - kIvBytes, out, n, &used) == kCCSuccess;
    for (volatile u8* p = key; p < key + sizeof(key); p++) *p = 0;
    if (!ok) {
        free(out);
        return {};
    }
    out[used] = 0;
    return Str(out, (int)used);
}
