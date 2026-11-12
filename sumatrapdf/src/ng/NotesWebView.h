#include "gui/BrowserView.h"
struct WebViewResourceResult {
    const u8* data = nullptr;
    int dataLen = 0;
    Str contentType;
};
struct CreateWebViewArgs {
    HWND parent = nullptr;
    Rect pos;
};
struct NotesWebBase : BrowserViewCallback {
    BrowserView* browser = nullptr;
    HWND hwnd = nullptr;
    Str dataDir;
    WStr resourceUriPrefix;
    Color defaultBackgroundColor = 0;
    bool allowClipboardRead = false;
    bool allowExternalDrop = false;
    struct {
        void* ctx;
        bool (*fn)(void*, Str, WebViewResourceResult*);
    } resourceProvider{};
    struct {
        void* ctx = nullptr;
        void (*jsCall)(void*, Str, Str, Str) = nullptr;
        bool (*navigationStarting)(void*, Str, bool) = nullptr;
        int (*resolveAccelCmd)(void*, u16, bool, bool, bool) = nullptr;
    } events;
    Str testResult;
    void TestEval(Str script);
    void OnJsNotify(Str method, Str params) override;
    Str bound;
    Str host;
    StrVec paths;
    StrVec assets;
    bool visible = false;
    ~NotesWebBase() override;
    bool Create(const CreateWebViewArgs&);
    void Bind(Str method);
    void Navigate(Str url);
    void Eval(Str js);
    void Resolve(Str id, int status, Str result);
    void SetIsVisible(bool);
    bool IsVisible() const { return visible; }
    void Focus() {}
    void ShowFindUI() { BrowserViewFindInPageUI(browser); }
    bool OnBeforeNavigate(Str url, bool newWindow) override;
    void OnDocumentComplete(Str) override {}
    Str GetDataForUrl(Str url) override;
    void OnLButtonDown() override {}
    void DownloadData(Str, Str) override {}
    void OnJsCall(Str id, Str method, Str params) override;
};
inline bool HasWebView() {
    return BrowserViewAvailable();
}
