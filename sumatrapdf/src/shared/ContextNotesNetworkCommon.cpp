/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#if defined(SUMATRA_NG)
#include "gui/GpuiBridge.h"
#else
#include "base/Base.h"
#endif
#include "base/Win.h"
#include "base/Http.h"
#include "base/JsonParser.h"
#include "base/UITask.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#if !defined(SUMATRA_NG)
#include "gui/win/WinGui.h"
#endif
#include "Settings.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "ContextNotesPlatform.h"
#include "ContextNotesNetwork.h"

constexpr int kNotesNetworkUrlLimit = 16 * 1024;
constexpr int kNotesNetworkHeaderLimit = 32 * 1024;
constexpr int kNotesNetworkBodyLimit = 16 * 1024 * 1024;
constexpr i64 kNotesNetworkReplyLimit = (i64)32 * 1024 * 1024;

struct NotesNetworkEvent {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    Str payload;
};

static void DeliverNetworkEvent(NotesNetworkEvent* ev) {
    if (IsMainWindowValid(ev->win) && NotesFrame(ev->win) == ev->frame) {
        EmitContextNotesNetwork(ev->win, ev->payload);
    }
    str::Free(ev->payload);
    delete ev;
}

static void PostNetworkEvent(MainWindow* win, HWND frame, Str payload) {
    auto* ev = new NotesNetworkEvent();
    ev->win = win;
    ev->frame = frame;
    ev->payload = str::Dup(payload);
    uitask::Post(MkFunc0(DeliverNetworkEvent, ev), "ContextNotesNetwork");
}

static TempStr NetworkQuote(Str value) {
    return fmt("\"%s\"", json::EscapeStrTemp(value));
}

struct NotesNetworkRequest : HttpStreamSink {
    MainWindow* win = nullptr;
    HWND frame = nullptr;
    Str id;
    Str method;
    Str url;
    Str headers;
    Str body;
    HttpStreamCancel cancel;
    i64 received = 0;
    bool tooLarge = false;

    ~NotesNetworkRequest() {
        str::Free(id);
        str::Free(method);
        str::Free(url);
        str::Free(headers);
        str::Free(body);
    }

    bool IsCanceled() override { return cancel.IsCanceled(); }

    void OnStatus(int status) override {
        AutoArenaSavepoint scratch;
        if (!IsCanceled()) {
            PostNetworkEvent(win, frame, fmt("{\"id\":%s,\"status\":%d}", NetworkQuote(id), status));
        }
    }

    bool OnData(Str bytes) override {
        AutoArenaSavepoint scratch;
        if (IsCanceled()) return false;
        received += len(bytes);
        if (received > kNotesNetworkReplyLimit) {
            tooLarge = true;
            return false;
        }
        str::Builder encoded;
        str::AppendBase64(encoded, (const u8*)bytes.s, (size_t)len(bytes));
        PostNetworkEvent(win, frame, fmt("{\"id\":%s,\"chunk\":%s}", NetworkQuote(id), NetworkQuote(ToStr(encoded))));
        return true;
    }
};

static Mutex gNotesNetworkMutex;
static Vec<NotesNetworkRequest*> gNotesNetworkRequests;

static void RunNotesNetwork(NotesNetworkRequest* req) {
    bool ok = HttpRequestStream(req->method, req->url, req->headers, req->body, req, &req->cancel);
    if (!req->IsCanceled()) {
        if (ok) {
            PostNetworkEvent(req->win, req->frame, fmt("{\"id\":%s,\"done\":true}", NetworkQuote(req->id)));
        } else {
            Str error = req->tooLarge
                            ? StrL("The API response exceeds the size limit.")
                            : StrL("Could not complete the API request. Check the URL, proxy and network connection.");
            PostNetworkEvent(req->win, req->frame,
                             fmt("{\"id\":%s,\"error\":%s}", NetworkQuote(req->id), NetworkQuote(error)));
        }
    }
    {
        ScopedMutex lock(&gNotesNetworkMutex);
        VecRemove(gNotesNetworkRequests, req);
    }
    delete req;
}

static bool ValidNetworkUrl(Str url) {
    if (len(url) == 0 || len(url) > kNotesNetworkUrlLimit) return false;
    for (int i = 0; i < len(url); i++) {
        u8 c = (u8)url.s[i];
        if (c <= ' ' || c == 0x7f || c == '#') return false;
    }
#if OS_WIN
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = parts.dwHostNameLength = parts.dwUserNameLength = parts.dwPasswordLength = (DWORD)-1;
    if (!InternetCrackUrlW(CWStrTemp(url), 0, 0, &parts)) return false;
    bool user = parts.dwUserNameLength != 0 && parts.dwUserNameLength != (DWORD)-1;
    bool password = parts.dwPasswordLength != 0 && parts.dwPasswordLength != (DWORD)-1;
    return (parts.nScheme == INTERNET_SCHEME_HTTP || parts.nScheme == INTERNET_SCHEME_HTTPS) && !user && !password &&
           parts.lpszHostName && parts.dwHostNameLength > 0 && parts.dwHostNameLength <= 253;
#else
    Str authority = url;
    if (!str::TrimPrefix(authority, StrL("https://")) && !str::TrimPrefix(authority, StrL("http://"))) return false;
    int end = 0;
    while (end < len(authority) && authority.s[end] != '/' && authority.s[end] != '?') end++;
    authority = Str(authority.s, end);
    return len(authority) > 0 && len(authority) <= 259 && !str::Contains(authority, StrL("@")) &&
           !str::Contains(authority, StrL("\\"));
#endif
}

static bool HeaderNameAllowed(Str name) {
    if (len(name) == 0 || len(name) > 128) return false;
    for (int i = 0; i < len(name); i++) {
        char c = name.s[i];
        bool letter = c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z';
        bool digit = c >= '0' && c <= '9';
        if (!letter && !digit && !str::Contains(StrL("!#$%&'*+-.^_`|~"), Str(&c, 1))) return false;
    }
    Str forbidden[] = {StrL("Host"),       StrL("Content-Length"),      StrL("Transfer-Encoding"),
                       StrL("Connection"), StrL("Proxy-Authorization"), StrL("Proxy-Connection"),
                       StrL("Upgrade")};
    for (Str token : forbidden) {
        if (str::EqI(name, token)) return false;
    }
    return true;
}

static bool ParseNetworkHeaders(Str headerJson, Str& out) {
    if (len(headerJson) > kNotesNetworkHeaderLimit) return false;
    str::TrimWSInPlace(headerJson, str::TrimOpt::Both);
    if (len(headerJson) < 2 || headerJson.s[0] != '{' || headerJson.s[len(headerJson) - 1] != '}') return false;
    str::Builder headers;
    StrVec names;
    json::Reader reader(headerJson);
    for (json::Value& value : reader) {
        if (!value.path || value.path->next || value.type != json::Type::String) return false;
        Str name = json::PathSegKey(value.path);
        if (!HeaderNameAllowed(name) || names.FindI(name) >= 0) return false;
        names.Append(name);
        for (int i = 0; i < len(value.value); i++) {
            u8 c = (u8)value.value.s[i];
            if (c < ' ' && c != '\t' || c == 0x7f) return false;
        }
        headers.Append(fmt("%s: %s\r\n", name, value.value));
    }
    if (!reader.Ok()) return false;
    out = str::Dup(ToStr(headers));
    return true;
}

static void RejectNetworkRequest(MainWindow* win, Str id, Str error) {
    EmitContextNotesNetwork(win, fmt("{\"id\":%s,\"error\":%s}", NetworkQuote(id), NetworkQuote(error)));
}

void StartContextNotesFetch(MainWindow* win, Str id, Str requestJson) {
    if (!IsMainWindowValid(win)) return;
    if (!HasPermission(Perm::InternetAccess)) {
        RejectNetworkRequest(win, id, StrL("Internet access is disabled in this SumatraPDF session."));
        return;
    }
    if (len(id) == 0 || len(id) > 128 || len(requestJson) > kNotesNetworkBodyLimit + kNotesNetworkHeaderLimit) {
        RejectNetworkRequest(win, id, StrL("Invalid API request."));
        return;
    }
    auto* req = new NotesNetworkRequest();
    req->win = win;
    req->frame = NotesFrame(win);
    req->id = str::Dup(id);
    Str headerJson;
    bool valid = true;
    json::Reader reader(requestJson);
    for (json::Value& value : reader) {
        if (!value.path || value.path->next || value.type != json::Type::String) {
            valid = false;
            break;
        }
        Str field = json::PathSegKey(value.path);
        if (str::Eq(field, StrL("url")))
            str::ReplaceWithCopy(&req->url, value.value);
        else if (str::Eq(field, StrL("method")))
            str::ReplaceWithCopy(&req->method, value.value);
        else if (str::Eq(field, StrL("headers")))
            str::ReplaceWithCopy(&headerJson, value.value);
        else if (str::Eq(field, StrL("body")))
            str::ReplaceWithCopy(&req->body, value.value);
    }
    AutoFree<char> freeHeaderJson(headerJson.s);
    valid = valid && reader.Ok() && ValidNetworkUrl(req->url) && len(req->body) <= kNotesNetworkBodyLimit &&
            (str::Eq(req->method, StrL("GET")) || str::Eq(req->method, StrL("POST"))) &&
            ParseNetworkHeaders(headerJson ? headerJson : StrL("{}"), req->headers);
    if (!valid) {
        delete req;
        RejectNetworkRequest(
            win, id, StrL("Invalid API URL, method or headers. Use HTTP(S), GET/POST and valid header values."));
        return;
    }
    bool duplicate = false;
    {
        ScopedMutex lock(&gNotesNetworkMutex);
        for (NotesNetworkRequest* current : gNotesNetworkRequests) {
            if (current->win == win && str::Eq(current->id, id)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) VecAppend(gNotesNetworkRequests, req);
    }
    if (duplicate) {
        delete req;
        RejectNetworkRequest(win, id, StrL("The API request id is already in use."));
        return;
    }
    ThreadHandle thread = StartThread(MkFunc0(RunNotesNetwork, req), StrL("ContextNotesFetch"));
    if (!thread) {
        {
            ScopedMutex lock(&gNotesNetworkMutex);
            VecRemove(gNotesNetworkRequests, req);
        }
        delete req;
        RejectNetworkRequest(win, id, StrL("Could not start the API request."));
        return;
    }
    SafeCloseThreadHandle(&thread);
}

void CancelContextNotesFetch(MainWindow* win, Str id) {
    ScopedMutex lock(&gNotesNetworkMutex);
    for (NotesNetworkRequest* req : gNotesNetworkRequests) {
        if (req->win == win && str::Eq(req->id, id)) req->cancel.Cancel();
    }
}

void CancelContextNotesFetches(MainWindow* win) {
    ScopedMutex lock(&gNotesNetworkMutex);
    for (NotesNetworkRequest* req : gNotesNetworkRequests) {
        if (req->win == win) req->cancel.Cancel();
    }
}
