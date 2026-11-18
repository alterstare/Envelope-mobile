package com.alterstare.envelope;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

// Serves the app's file urls, same-origin with the app:
//   https://localhost/_s/img/<b64url path>       a picture as it is (NAS: through the cache)
//   https://localhost/_s/th/<b64url path>?m=…    a 미리 보기 (480px) of a picture, phone or NAS
//   https://localhost/_s/raw/<b64url path>       a file as it is now, no cache (the 모바일 정보
//                                                파일, subtitle files); X-Size = its byte size
// Everything else falls through to Capacitor's local server. Audio doesn't
// come through here: the player (PlaybackService) reads files itself.
final class EnvWebViewClient extends BridgeWebViewClient {
    private static final String PREFIX = "/_s/";
    private static final int THUMB = 480;

    EnvWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String path = u.getPath();
        if ("localhost".equals(u.getHost()) && path != null && path.startsWith(PREFIX)) return serve(path.substring(PREFIX.length()), u);
        return super.shouldInterceptRequest(view, request);
    }

    private static String dec(String s) {
        return new String(Base64.decode(s, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), StandardCharsets.UTF_8);
    }

    private static WebResourceResponse serve(String rest, Uri u) {
        int slash = rest.indexOf('/');
        if (slash < 0) return error(400);
        String kind = rest.substring(0, slash);
        String target;
        try {
            target = dec(rest.substring(slash + 1));
        } catch (IllegalArgumentException e) {
            return error(400);
        }
        try {
            switch (kind) {
                case "img":
                    if (Vfs.isRemote(target)) return ok(mimeOf(target), new ByteArrayInputStream(ImgCache.nas(target)), true);
                    File f = new File(target);
                    if (!f.isFile()) return error(404);
                    return ok(mimeOf(target), new FileInputStream(f), true);
                case "th": {
                    String key = "th|" + target + "|" + u.getQueryParameter("m");
                    byte[] b = ImgCache.get(key);
                    if (b == null) {
                        b = ImgCache.thumb(Vfs.isRemote(target) ? ImgCache.nas(target) : Vfs.read(target), THUMB);
                        ImgCache.put(key, b);
                    }
                    return ok("image/webp", new ByteArrayInputStream(b), true);
                }
                case "raw": {
                    RemoteFs.Entry e = Vfs.stat(target);
                    if (!e.exists) return error(404);
                    WebResourceResponse r = ok("application/octet-stream", Vfs.open(target), false);
                    Map<String, String> h = new HashMap<>(r.getResponseHeaders());
                    h.put("X-Size", String.valueOf(e.size));
                    r.setResponseHeaders(h);
                    return r;
                }
                default:
                    return error(400);
            }
        } catch (IOException e) {
            String m = String.valueOf(e.getMessage());
            return error(m.startsWith("ENOENT") || m.contains("404") ? 404 : 502);
        } catch (RuntimeException e) {
            return error(500);
        }
    }

    private static WebResourceResponse ok(String mime, InputStream in, boolean cache) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", cache ? "public, max-age=604800, immutable" : "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(mime, null, 200, "OK", h, in);
    }

    private static WebResourceResponse error(int code) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", code, code == 404 ? "Not Found" : "Error", h, new ByteArrayInputStream(new byte[0]));
    }

    static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".avif")) return "image/avif";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".bmp")) return "image/bmp";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "image/*";
    }
}
