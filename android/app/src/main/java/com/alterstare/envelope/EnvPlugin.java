package com.alterstare.envelope;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.widget.Toast;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// JS bridge (src/backend/native.ts): NAS connections, files (phone paths or
// /nas/<id>/…), the folder picker, storage permission, the player
// (PlaybackService) and the 떠 있는 자막 window.
@CapacitorPlugin(
    name = "Envelope",
    permissions = {
        @Permission(strings = {Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, alias = "storage")
    }
)
public class EnvPlugin extends Plugin {
    static EnvPlugin instance;
    private final ExecutorService io = Executors.newFixedThreadPool(6);

    @Override
    public void load() {
        instance = this;
        NasStore.init(getContext());
        ImgCache.init(getContext());
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        notifyListeners("pause", new JSObject());
        PlaybackService p = PlaybackService.instance;
        if (p != null) p.setAppVisible(false);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("resume", new JSObject());
        PlaybackService p = PlaybackService.instance;
        if (p != null) {
            p.setAppVisible(true);
            p.emitOverlay(); // the overlay permission may have changed in the settings
        }
    }

    // Android back → JS decides (close something / step back / exit).
    boolean handleBack() {
        if (!hasListeners("back")) return false;
        notifyListeners("back", new JSObject());
        return true;
    }

    private interface Job {
        void run() throws Exception;
    }

    private void bg(PluginCall call, Job job) {
        io.execute(() -> {
            try {
                job.run();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage() != null ? e.getMessage() : e));
            }
        });
    }

    private static String need(PluginCall call, String key) {
        String v = call.getString(key);
        if (v == null) throw new IllegalArgumentException("missing " + key);
        return v;
    }

    // ---- NAS (SMB / WebDAV) — passwords stay here (NasStore), JS never sees them ----

    @PluginMethod
    public void nasList(PluginCall call) {
        try {
            JSArray a = new JSArray();
            for (NasStore.Conn c : NasStore.list()) {
                JSObject j = JSObject.fromJSONObject(c.toJson(true, NasStore.password(c.id)));
                String sp = NasStore.smbPassword(c.id);
                j.put("hasSmbPassword", sp != null && !sp.isEmpty());
                a.put(j);
            }
            JSObject o = new JSObject();
            o.put("conns", a);
            call.resolve(o);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    private static NasStore.Conn connOf(PluginCall call) {
        JSObject j = call.getObject("conn");
        NasStore.Conn c = NasStore.Conn.fromJson(j == null ? new JSObject() : j);
        c.type = Vfs.hasSmb(c) ? (Vfs.hasDav(c) ? "both" : "smb") : "webdav";
        return c;
    }

    @PluginMethod
    public void nasTest(PluginCall call) {
        bg(call, () -> {
            // One way at a time ("smb" | "webdav"): the tab being filled in.
            NasStore.Conn c = connOf(call);
            boolean smb = "smb".equals(call.getString("via"));
            boolean known = c.id != null && !c.id.isEmpty();
            String pw = call.getString(smb ? "smbPassword" : "password");
            if (pw == null && known) pw = smb ? NasStore.smbPassword(c.id) : NasStore.password(c.id);
            RemoteFs fs = smb ? new SmbFs(c, pw) : new WebDavFs(c, pw);
            try {
                int n = 0;
                if (smb) {
                    List<RemoteFs.Entry> shares = fs.list("");
                    if (shares.isEmpty()) throw new IOException("공유 폴더 이름을 입력하세요");
                    for (RemoteFs.Entry s : shares) n += fs.list(s.name).size(); // each share must open
                } else n = fs.list("").size();
                JSObject o = new JSObject();
                o.put("count", n);
                call.resolve(o);
            } finally {
                fs.close();
            }
        });
    }

    @PluginMethod
    public void nasSave(PluginCall call) {
        bg(call, () -> {
            NasStore.Conn c = connOf(call);
            if (c.id == null || c.id.isEmpty()) c.id = "n" + Long.toString(System.currentTimeMillis(), 36);
            NasStore.save(c, call.getString("password"), call.getString("smbPassword"));
            Vfs.forget(c.id);
            JSObject o = new JSObject();
            o.put("id", c.id);
            call.resolve(o);
        });
    }

    // What a connection uses now ("smb" | "webdav"); recheck looks for SMB again.
    @PluginMethod
    public void nasVia(PluginCall call) {
        bg(call, () -> {
            JSObject o = new JSObject();
            o.put("via", Vfs.via(need(call, "id"), Boolean.TRUE.equals(call.getBoolean("recheck", false))));
            call.resolve(o);
        });
    }

    @PluginMethod
    public void nasRemove(PluginCall call) {
        bg(call, () -> {
            String id = need(call, "id");
            NasStore.remove(id);
            Vfs.forget(id);
            call.resolve();
        });
    }

    // ---- files ----

    @PluginMethod
    public void fsReadText(PluginCall call) {
        bg(call, () -> {
            JSObject o = new JSObject();
            o.put("data", new String(Vfs.read(need(call, "path")), StandardCharsets.UTF_8));
            call.resolve(o);
        });
    }

    @PluginMethod
    public void fsWriteText(PluginCall call) {
        bg(call, () -> {
            Vfs.write(need(call, "path"), need(call, "data").getBytes(StandardCharsets.UTF_8));
            call.resolve();
        });
    }

    private static JSObject statOf(RemoteFs.Entry e) {
        JSObject o = new JSObject();
        o.put("name", e.name);
        o.put("exists", e.exists);
        o.put("isDir", e.exists && e.dir);
        o.put("isFile", e.exists && !e.dir);
        o.put("size", e.size);
        o.put("mtime", e.mtime);
        return o;
    }

    @PluginMethod
    public void fsStat(PluginCall call) {
        bg(call, () -> call.resolve(statOf(Vfs.stat(need(call, "path")))));
    }

    @PluginMethod
    public void fsReaddir(PluginCall call) {
        bg(call, () -> {
            String path = need(call, "path");
            JSArray arr = new JSArray();
            if (Vfs.isRemote(path)) {
                for (RemoteFs.Entry e : Vfs.list(path)) arr.put(statOf(e));
            } else {
                File[] list = new File(path).listFiles();
                if (list == null) throw new IOException("ENOENT: " + path);
                for (File f : list) arr.put(statOf(Vfs.stat(f.getPath())));
            }
            JSObject res = new JSObject();
            res.put("entries", arr);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void fsMkdir(PluginCall call) {
        bg(call, () -> {
            String path = need(call, "path");
            if (Vfs.isRemote(path)) Vfs.mkdirs(path);
            else if (!new File(path).isDirectory() && !new File(path).mkdirs()) throw new IOException("mkdir failed: " + path);
            call.resolve();
        });
    }

    // NAS files only (the phone's own pictures go through deleteLocal).
    @PluginMethod
    public void fsRm(PluginCall call) {
        bg(call, () -> {
            String path = need(call, "path");
            if (!Vfs.isRemote(path)) throw new IOException("not a NAS path");
            Vfs.delete(path, false);
            call.resolve();
        });
    }

    // ---- 업데이트 알림 ----

    // The release page in the browser (the user installs the APK there; the
    // app never downloads / installs APKs — Play Protect flags that).
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = need(call, "url");
        if (!url.startsWith("https://")) {
            call.reject("https only");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ---- folder picker / storage ----

    @PluginMethod
    public void pickFolder(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderResult");
    }

    // content://…/tree/primary%3ADCIM%2FCamera → /storage/emulated/0/DCIM/Camera
    @ActivityCallback
    private void folderResult(PluginCall call, ActivityResult result) {
        JSObject o = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            o.put("path", null);
            call.resolve(o);
            return;
        }
        String docId = DocumentsContract.getTreeDocumentId(data.getData());
        int colon = docId.indexOf(':');
        String vol = colon >= 0 ? docId.substring(0, colon) : docId;
        String rel = colon >= 0 ? docId.substring(colon + 1) : "";
        String base = "primary".equalsIgnoreCase(vol) ? Environment.getExternalStorageDirectory().getAbsolutePath() : "/storage/" + vol;
        o.put("path", rel.isEmpty() ? base : base + "/" + rel);
        call.resolve(o);
    }

    private boolean storageGranted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return getPermissionState("storage") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void storageStatus(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", storageGranted());
        call.resolve(o);
    }

    // Android 11+: the "모든 파일에 접근" settings page; older: the runtime permission.
    @PluginMethod
    public void requestStorage(PluginCall call) {
        if (storageGranted()) {
            storageStatus(call);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            try {
                startActivityForResult(call, i, "storageResult");
            } catch (Exception e) {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "storageResult");
            }
        } else {
            requestPermissionForAlias("storage", call, "storagePermResult");
        }
    }

    @ActivityCallback
    private void storageResult(PluginCall call, ActivityResult result) {
        storageStatus(call);
    }

    @PermissionCallback
    private void storagePermResult(PluginCall call) {
        storageStatus(call);
    }

    // ---- app ----

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject o = new JSObject();
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            o.put("version", pi.versionName);
            o.put("dataDir", getContext().getFilesDir().getAbsolutePath());
            o.put("code", Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception e) {
            o.put("version", "0");
            o.put("code", 0);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getContext().getSharedPreferences("envelope", android.content.Context.MODE_PRIVATE).edit().putBoolean("dark", dark).apply();
        getActivity().runOnUiThread(() -> MainActivity.applyTheme(getActivity(), getBridge().getWebView(), dark));
        call.resolve();
    }

    @PluginMethod
    public void toast(PluginCall call) {
        String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> Toast.makeText(getContext(), text, Toast.LENGTH_SHORT).show());
        call.resolve();
    }

    @PluginMethod
    // Back on the library: the app goes behind (playback and the 떠 있는 자막 stay).
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
    }

    @PluginMethod
    public void cacheInfo(PluginCall call) {
        bg(call, () -> {
            long[] u = ImgCache.usage();
            JSObject o = new JSObject();
            o.put("bytes", u[0]);
            o.put("files", u[1]);
            call.resolve(o);
        });
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        bg(call, () -> {
            ImgCache.clear();
            call.resolve();
        });
    }

    @PluginMethod
    public void setCacheLimit(PluginCall call) {
        Double b = call.getDouble("bytes");
        ImgCache.setLimit(b == null ? 1024L * 1024 * 1024 : b.longValue());
        call.resolve();
    }
    // ---- player (PlaybackService) ----

    private boolean askedNotify;
    static final int NOTIFY_REQ = 7302;
    private boolean sinkSet;

    private interface WithService {
        void run(PlaybackService p) throws Exception;
    }

    // The service's events reach JS as "player" / "overlay" / "sleep" / "error".
    private void withService(PluginCall call, WithService fn) {
        android.content.Context ctx = getContext();
        if (!sinkSet) {
            sinkSet = true;
            PlaybackService.sink = (ev, data) -> {
                try {
                    notifyListeners(ev, JSObject.fromJSONObject(data));
                } catch (org.json.JSONException ignored) {
                }
            };
        }
        getActivity().runOnUiThread(() -> PlaybackService.whenReady(ctx, () -> {
            try {
                PlaybackService p = PlaybackService.instance;
                p.setAppVisible(isResumed());
                fn.run(p);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }));
    }

    private boolean isResumed() {
        return getActivity().getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED);
    }

    // The media notification needs this permission (Android 13+); asked once, at the first play.
    private void askNotify() {
        android.content.Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 33 && !askedNotify
            && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            askedNotify = true;
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFY_REQ);
        }
    }

    // {items: [{key, path, title, artist, album}], index, start (s), play, cover (picture path or "")}
    @PluginMethod
    public void playerLoad(PluginCall call) {
        JSArray items = call.getArray("items", new JSArray());
        int index = call.getInt("index", 0);
        double start = call.getDouble("start", 0.0);
        boolean play = Boolean.TRUE.equals(call.getBoolean("play", true));
        String cover = call.getString("cover", "");
        if (play) askNotify();
        io.execute(() -> {
            byte[] art = null;
            if (cover != null && !cover.isEmpty()) {
                try {
                    byte[] raw = Vfs.isRemote(cover) ? ImgCache.nas(cover) : Vfs.read(cover);
                    art = ImgCache.thumb(raw, 512);
                } catch (Exception ignored) {
                    // no picture in the notification
                }
            }
            final byte[] pic = art;
            withService(call, (p) -> {
                p.setQueue(items, index, (long) (start * 1000), play, pic);
                call.resolve();
            });
        });
    }

    // {op: play | pause | seek | seekTo | next | prev | rate | repeat | shuffle | stop, value}
    @PluginMethod
    public void playerControl(PluginCall call) {
        String op = call.getString("op", "");
        double v = call.getDouble("value", 0.0);
        if ("play".equals(op)) askNotify();
        withService(call, (p) -> {
            p.control(op, v);
            call.resolve();
        });
    }

    // {index, orig: {s, e, t} | null, trans: … | null, offset}
    @PluginMethod
    public void playerCues(PluginCall call) {
        int index = call.getInt("index", -1);
        JSObject orig = call.getObject("orig", null);
        JSObject trans = call.getObject("trans", null);
        double offset = call.getDouble("offset", 0.0);
        withService(call, (p) -> {
            p.setCues(index, orig, trans, offset);
            call.resolve();
        });
    }

    @PluginMethod
    public void playerOffset(PluginCall call) {
        int index = call.getInt("index", -1);
        double offset = call.getDouble("offset", 0.0);
        withService(call, (p) -> {
            p.setOffset(index, offset);
            call.resolve();
        });
    }

    @PluginMethod
    public void playerSubMode(PluginCall call) {
        String mode = call.getString("mode", "both");
        withService(call, (p) -> {
            p.setSubMode(mode);
            call.resolve();
        });
    }

    // {mode: off | time | track | work, minutes}
    @PluginMethod
    public void playerSleep(PluginCall call) {
        String mode = call.getString("mode", "off");
        double minutes = call.getDouble("minutes", 0.0);
        withService(call, (p) -> {
            p.setSleep(mode, minutes);
            call.resolve();
        });
    }

    @PluginMethod
    public void playerState(PluginCall call) {
        if (PlaybackService.instance == null) {
            JSObject o = new JSObject();
            o.put("index", -1);
            o.put("keys", new JSArray());
            call.resolve(o);
            return;
        }
        withService(call, (p) -> call.resolve(JSObject.fromJSONObject(p.state())));
    }

    // Progress the service recorded (also while JS slept): {key: {p, d, t}}; p huge = heard to the end.
    @PluginMethod
    public void playerDrain(PluginCall call) {
        if (PlaybackService.instance == null) {
            android.content.SharedPreferences sp = getContext().getSharedPreferences("player", android.content.Context.MODE_PRIVATE);
            String s = sp.getString("progress", "{}");
            sp.edit().remove("progress").apply();
            try {
                JSObject o = new JSObject();
                o.put("progress", new JSObject(s));
                call.resolve(o);
            } catch (org.json.JSONException e) {
                call.reject(e.getMessage());
            }
            return;
        }
        withService(call, (p) -> {
            JSObject o = new JSObject();
            o.put("progress", JSObject.fromJSONObject(p.drain()));
            call.resolve(o);
        });
    }

    // ---- 떠 있는 자막 ----

    // {enabled?, locked?, size?, opacity?, hideInApp?}
    @PluginMethod
    public void overlaySet(PluginCall call) {
        JSObject o = call.getData();
        withService(call, (p) -> {
            p.overlayConfig(o);
            p.emitOverlay();
            call.resolve();
        });
    }

    @PluginMethod
    public void overlayStatus(PluginCall call) {
        JSObject o = new JSObject();
        android.content.SharedPreferences sp = getContext().getSharedPreferences("overlay", android.content.Context.MODE_PRIVATE);
        PlaybackService p = PlaybackService.instance;
        o.put("allowed", SubOverlay.allowed(getContext()));
        o.put("enabled", p != null ? p.overlay.enabled : sp.getBoolean("enabled", false));
        o.put("locked", p != null ? p.overlay.locked : sp.getBoolean("locked", false));
        o.put("size", p != null ? p.overlay.size : sp.getFloat("size", 18));
        call.resolve(o);
    }

    // The "다른 앱 위에 표시" settings page of this app; resolves with the answer on return.
    @PluginMethod
    public void overlayPermission(PluginCall call) {
        if (SubOverlay.allowed(getContext())) {
            overlayStatus(call);
            return;
        }
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, i, "overlayResult");
    }

    @ActivityCallback
    private void overlayResult(PluginCall call, ActivityResult result) {
        overlayStatus(call);
    }
}
