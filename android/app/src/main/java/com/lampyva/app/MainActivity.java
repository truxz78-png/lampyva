package com.lampyva.app;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Lampyva for Android: shows the Lampyva website (all tools run inside the phone),
 * opens other sites in a browser tab, lets the user pick images and saves results in Downloads.
 */
public class MainActivity extends AppCompatActivity {

    static final String HOME = "https://truxz78-png.github.io/lampyva/";
    static final String HOST = "truxz78-png.github.io";
    static final String PATH = "/lampyva";
    static final int BG = 0xFF0A0A24;

    private FrameLayout root;
    private WebView web;
    private volatile String currentUrl = "";
    private ValueCallback<Uri[]> fileCallback;
    private ActivityResultLauncher<Intent> picker;
    private final Map<String, Saving> saves = new ConcurrentHashMap<>();

    static class Saving {
        final Uri uri;
        final OutputStream out;
        Saving(Uri uri, OutputStream out) { this.uri = uri; this.out = out; }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        // Android 15+ draws behind the system bars: keep the page between them
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        picker = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback == null) return;
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web != null && web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });

        createWebView();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(HOME);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false);
        // lets the website know it runs inside the app (it hides donations here and saves files through the app)
        s.setUserAgentString(s.getUserAgentString() + " LampyvaApp/1");

        web.addJavascriptInterface(new Bridge(), "LampyvaAndroid");
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            if (url != null && url.startsWith("http")) openOutside(Uri.parse(url));
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isOurs(u)) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                currentUrl = url == null ? "" : url;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                currentUrl = url == null ? "" : url;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // the page ran out of memory (for example a very big image): start again instead of closing the app
                root.removeView(web);
                web.destroy();
                web = null;
                createWebView();
                web.loadUrl(HOME);
                Toast.makeText(MainActivity.this, text(MEMORY), Toast.LENGTH_LONG).show();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] mimes = mimeTypes(params.getAcceptTypes());
                if (mimes.length == 1) {
                    i.setType(mimes[0]);
                } else {
                    i.setType("*/*");
                    if (mimes.length > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                }
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    picker.launch(i);
                } catch (ActivityNotFoundException e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    /** Lampyva's own pages stay in the app. */
    static boolean isOurs(Uri u) {
        if (u == null) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        return "https".equals(u.getScheme()) && HOST.equalsIgnoreCase(u.getHost())
                && (path.equals(PATH) || path.startsWith(PATH + "/"));
    }

    /** Other sites (PayPal, GitHub, model licenses...) open in a browser tab; e-mail links in the mail app. */
    private void openOutside(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        try {
            if (scheme.equals("http") || scheme.equals("https")) {
                CustomTabColorSchemeParams colors = new CustomTabColorSchemeParams.Builder().setToolbarColor(BG).build();
                new CustomTabsIntent.Builder().setDefaultColorSchemeParams(colors).setShowTitle(true).build().launchUrl(this, u);
            } else if (scheme.equals("mailto")) {
                startActivity(new Intent(Intent.ACTION_SENDTO, u));
            } else if (scheme.equals("intent")) {
                Intent i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException e) {
                    String fallback = i.getStringExtra("browser_fallback_url");
                    if (fallback != null) openOutside(Uri.parse(fallback));
                }
            } else {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            }
        } catch (Exception e) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
        }
    }

    /** accept=".heic,image/*" → MIME types for Android's file picker (no filter if one is unknown). */
    static String[] mimeTypes(String[] accept) {
        List<String> out = new ArrayList<>();
        if (accept != null) {
            for (String group : accept) {
                if (group == null) continue;
                for (String t : group.split(",")) {
                    t = t.trim().toLowerCase(Locale.ROOT);
                    if (t.isEmpty()) continue;
                    if (t.contains("/")) { if (!out.contains(t)) out.add(t); continue; }
                    String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.replace(".", ""));
                    if (m == null) return new String[0];
                    if (!out.contains(m)) out.add(m);
                }
            }
        }
        if (out.contains("*/*")) return new String[0];
        return out.toArray(new String[0]);
    }

    private void showOffline() {
        String html = "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
                + "background:#0A0A24;color:#EDEBFF;font-family:sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
                + "a{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:12px;background:#F5B83D;color:#1a1300;"
                + "font-weight:bold;text-decoration:none}</style></head><body><div><div style='font-size:48px'>📡</div>"
                + "<p>" + text(OFFLINE) + "</p><a href='" + HOME + "'>" + text(RETRY) + "</a></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    // ---------- short texts shown by the app itself (the website translates everything else) ----------
    static final int OFFLINE = 0, RETRY = 1, MEMORY = 2;
    static final String[][] TEXTS = {
            // en, es, pt, fr
            {"No internet connection. Lampyva needs internet to open.", "Sin conexión a internet. Lampyva necesita internet para abrir.",
                    "Sem conexão com a internet. O Lampyva precisa de internet para abrir.", "Pas de connexion Internet. Lampyva a besoin d'Internet pour s'ouvrir."},
            {"Try again", "Reintentar", "Tentar de novo", "Réessayer"},
            {"The image was too big for this phone's memory. Try a smaller size.",
                    "La imagen era demasiado grande para la memoria de este teléfono. Prueba con un tamaño menor.",
                    "A imagem era grande demais para a memória deste celular. Tente um tamanho menor.",
                    "L'image était trop grande pour la mémoire de ce téléphone. Essayez une taille plus petite."},
    };

    static String text(int which) {
        String l = Locale.getDefault().getLanguage();
        int i = l.equals("es") ? 1 : l.equals("pt") ? 2 : l.equals("fr") ? 3 : 0;
        return TEXTS[which][i];
    }

    // ---------- saving results: the page sends the file in pieces, the app writes it to Downloads/Lampyva ----------
    class Bridge {
        private boolean trusted() {
            return isOurs(Uri.parse(currentUrl));
        }

        @JavascriptInterface
        public String begin(String name, String mime) {
            if (!trusted()) return "";
            try {
                String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
                if (clean.isEmpty()) clean = "lampyva-file";
                int dot = clean.lastIndexOf('.');
                String byExt = dot > 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(clean.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, clean);
                v.put(MediaStore.Downloads.MIME_TYPE, byExt != null ? byExt : (mime == null || mime.isEmpty() ? "application/octet-stream" : mime));
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Lampyva");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver cr = getContentResolver();
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "";
                OutputStream out = cr.openOutputStream(uri);
                if (out == null) { cr.delete(uri, null, null); return ""; }
                String id = UUID.randomUUID().toString();
                saves.put(id, new Saving(uri, out));
                return id;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean append(String id, String base64) {
            Saving s = saves.get(id);
            if (s == null) return false;
            try {
                s.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                cancel(id);
                return false;
            }
        }

        @JavascriptInterface
        public boolean finish(String id) {
            Saving s = saves.remove(id);
            if (s == null) return false;
            try {
                s.out.close();
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(s.uri, v, null, null);
                return true;
            } catch (Exception e) {
                try { getContentResolver().delete(s.uri, null, null); } catch (Exception ignored) { }
                return false;
            }
        }

        @JavascriptInterface
        public void cancel(String id) {
            Saving s = saves.remove(id);
            if (s == null) return;
            try { s.out.close(); } catch (Exception ignored) { }
            try { getContentResolver().delete(s.uri, null, null); } catch (Exception ignored) { }
        }
    }

    @Override
    protected void onDestroy() {
        for (String id : saves.keySet()) new Bridge().cancel(id);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
