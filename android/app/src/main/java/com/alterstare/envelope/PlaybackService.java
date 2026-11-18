package com.alterstare.envelope;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

// Playback lives here, not in the WebView: ExoPlayer in a media session
// service, so it goes on with the screen off or another app in front, shows
// the media notification / lock screen controls and takes headset keys.
// The queue is one work's tracks (JS sends them with their subtitles), and
// the 떠 있는 자막 window reads the position from the player directly — the
// WebView may be paused in the background.
@UnstableApi
public class PlaybackService extends MediaSessionService {
    interface Sink {
        void emit(String event, JSONObject data);
    }

    static PlaybackService instance;
    static Sink sink;
    private static final List<Runnable> waiting = new ArrayList<>();

    private static final long TICK_MS = 250;
    private static final long SAVE_EVERY_MS = 5000;
    private static final long FADE_MS = 10_000; // sleep timer fades out over this long
    static final String CMD_OVERLAY = "env.overlay";
    static final String CMD_LOCK = "env.lock";

    private ExoPlayer player;
    private MediaSession session;
    SubOverlay overlay;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;

    // per queue item
    private static final class Cues {
        double[] s, e;
        String[] t;
    }

    private static final class Item {
        String key;
        Cues orig, trans;
        double offset;
    }

    private final List<Item> items = new ArrayList<>();
    private String subMode = "both";
    private long lastSave;
    private int ticks;

    // 수면 타이머: off | time | track | work
    private String sleepMode = "off";
    private long sleepEndsAt;
    private float baseVolume = 1f;

    // Run once the service is up (the plugin starts it on first use).
    static void whenReady(android.content.Context ctx, Runnable r) {
        if (instance != null) {
            r.run();
            return;
        }
        synchronized (waiting) {
            waiting.add(r);
        }
        ctx.startService(new Intent(ctx, PlaybackService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("player", MODE_PRIVATE);
        AudioAttributes attrs = new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build();
        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(() -> new NasDataSource.Routing(this)))
            .setAudioAttributes(attrs, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build();
        player.addListener(new Listener());
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, player).setSessionActivity(pi).setCallback(new Callback()).build();
        overlay = new SubOverlay(this, () -> {
            buttons();
            emitOverlay();
        });
        SharedPreferences o = getSharedPreferences("overlay", MODE_PRIVATE);
        overlay.enabled = o.getBoolean("enabled", false);
        overlay.locked = o.getBoolean("locked", false);
        overlay.size = o.getFloat("size", 18);
        overlay.opacity = o.getFloat("opacity", 0.86f);
        overlay.hideInApp = o.getBoolean("hideInApp", true);
        buttons();
        addSession(session);
        instance = this;
        List<Runnable> rs;
        synchronized (waiting) {
            rs = new ArrayList<>(waiting);
            waiting.clear();
        }
        for (Runnable r : rs) r.run();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo info) {
        return session;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        save();
        overlay.remove();
        instance = null;
        session.release();
        player.release();
        super.onDestroy();
    }

    // ---- the notification's extra buttons: 떠 있는 자막 on / off, 잠금 ----

    private void buttons() {
        if (session == null) return;
        List<CommandButton> list = new ArrayList<>();
        list.add(new CommandButton.Builder(CommandButton.ICON_UNDEFINED)
            .setCustomIconResId(overlay.enabled ? R.drawable.ic_closed_caption : R.drawable.ic_closed_caption_disabled)
            .setDisplayName(overlay.enabled ? "떠 있는 자막 끄기" : "떠 있는 자막 켜기")
            .setSessionCommand(new SessionCommand(CMD_OVERLAY, Bundle.EMPTY))
            .build());
        if (overlay.enabled)
            list.add(new CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                .setCustomIconResId(overlay.locked ? R.drawable.ic_lock : R.drawable.ic_lock_open)
                .setDisplayName(overlay.locked ? "자막 잠금 풀기" : "자막 잠그기")
                .setSessionCommand(new SessionCommand(CMD_LOCK, Bundle.EMPTY))
                .build());
        session.setMediaButtonPreferences(ImmutableList.copyOf(list));
        getSharedPreferences("overlay", MODE_PRIVATE).edit()
            .putBoolean("enabled", overlay.enabled).putBoolean("locked", overlay.locked).putFloat("size", overlay.size).apply();
    }

    private final class Callback implements MediaSession.Callback {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo c) {
            SessionCommands cmds = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(new SessionCommand(CMD_OVERLAY, Bundle.EMPTY))
                .add(new SessionCommand(CMD_LOCK, Bundle.EMPTY))
                .build();
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(s).setAvailableSessionCommands(cmds).build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo c, @NonNull SessionCommand cmd, @NonNull Bundle args) {
            if (CMD_OVERLAY.equals(cmd.customAction)) overlay.enabled = !overlay.enabled;
            else if (CMD_LOCK.equals(cmd.customAction)) overlay.locked = !overlay.locked;
            overlay.apply();
            updateOverlay();
            buttons();
            emitOverlay();
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    }

    // ---- queue ----

    // items: [{key, path, title, artist, album}], art = cover picture bytes (or null)
    void setQueue(JSONArray list, int index, long startMs, boolean play, @Nullable byte[] art) throws JSONException {
        save();
        items.clear();
        List<MediaItem> media = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.getJSONObject(i);
            Item it = new Item();
            it.key = o.getString("key");
            items.add(it);
            String path = o.getString("path");
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(o.optString("title"))
                .setArtist(o.optString("artist"))
                .setAlbumTitle(o.optString("album"));
            if (art != null) md.setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
            media.add(new MediaItem.Builder()
                .setMediaId(it.key)
                .setUri(Vfs.isRemote(path) ? NasDataSource.uriOf(path) : android.net.Uri.fromFile(new java.io.File(path)))
                .setMediaMetadata(md.build())
                .build());
        }
        player.setMediaItems(media, index, Math.max(0, startMs));
        player.prepare();
        player.setPlayWhenReady(play);
        overlay.hasMedia = !items.isEmpty();
        overlay.apply();
        updateOverlay();
        emitState();
    }

    void setCues(int index, @Nullable JSONObject orig, @Nullable JSONObject trans, double offset) throws JSONException {
        if (index < 0 || index >= items.size()) return;
        Item it = items.get(index);
        it.orig = cuesOf(orig);
        it.trans = cuesOf(trans);
        it.offset = offset;
        updateOverlay();
    }

    void setOffset(int index, double offset) {
        if (index < 0 || index >= items.size()) return;
        items.get(index).offset = offset;
        updateOverlay();
    }

    private static Cues cuesOf(@Nullable JSONObject o) throws JSONException {
        if (o == null) return null;
        JSONArray s = o.getJSONArray("s"), e = o.getJSONArray("e"), t = o.getJSONArray("t");
        Cues c = new Cues();
        c.s = new double[s.length()];
        c.e = new double[s.length()];
        c.t = new String[s.length()];
        for (int i = 0; i < s.length(); i++) {
            c.s[i] = s.getDouble(i);
            c.e[i] = e.getDouble(i);
            c.t[i] = t.getString(i);
        }
        return c.s.length == 0 ? null : c;
    }

    void control(String op, double arg) {
        switch (op) {
            case "play":
                if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
                player.play();
                break;
            case "pause":
                player.pause();
                break;
            case "seek":
                player.seekTo(Math.max(0, (long) (arg * 1000)));
                break;
            case "seekTo": // another queue item from its start
                player.seekTo((int) arg, 0);
                player.play();
                break;
            case "next":
                if (player.hasNextMediaItem()) player.seekToNextMediaItem();
                break;
            case "prev":
                player.seekToPrevious();
                break;
            case "rate":
                player.setPlaybackSpeed((float) arg);
                break;
            case "repeat": // 0 off · 1 all · 2 one
                player.setRepeatMode(arg == 2 ? Player.REPEAT_MODE_ONE : arg == 1 ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
                break;
            case "shuffle":
                player.setShuffleModeEnabled(arg != 0);
                break;
            case "stop":
                save();
                player.stop();
                player.clearMediaItems();
                items.clear();
                overlay.hasMedia = false;
                overlay.apply();
                setSleep("off", 0);
                break;
        }
        emitState();
    }

    void setSubMode(String m) {
        subMode = m;
        updateOverlay();
    }

    void overlayConfig(JSONObject o) {
        if (o.has("enabled")) overlay.enabled = o.optBoolean("enabled");
        if (o.has("locked")) overlay.locked = o.optBoolean("locked");
        if (o.has("size")) overlay.size = (float) o.optDouble("size", 18);
        if (o.has("opacity")) overlay.opacity = (float) o.optDouble("opacity", 0.86);
        if (o.has("hideInApp")) overlay.hideInApp = o.optBoolean("hideInApp", true);
        getSharedPreferences("overlay", MODE_PRIVATE).edit().putFloat("opacity", overlay.opacity).putBoolean("hideInApp", overlay.hideInApp).apply();
        overlay.apply();
        updateOverlay();
        buttons();
    }

    void setAppVisible(boolean v) {
        overlay.appVisible = v;
        overlay.apply();
        updateOverlay();
    }

    // ---- 수면 타이머 ----

    void setSleep(String mode, double minutes) {
        if (!"time".equals(sleepMode) || !"time".equals(mode)) restoreVolume();
        sleepMode = mode;
        sleepEndsAt = "time".equals(mode) ? System.currentTimeMillis() + (long) (minutes * 60_000) : 0;
        pauseAtEnd();
        emitSleep();
        if (player.isPlaying()) startTick();
    }

    private void pauseAtEnd() {
        boolean last = player.getCurrentMediaItemIndex() >= player.getMediaItemCount() - 1;
        player.setPauseAtEndOfMediaItems("track".equals(sleepMode) || ("work".equals(sleepMode) && last));
    }

    private void restoreVolume() {
        player.setVolume(baseVolume);
    }

    private void sleepDone() {
        player.pause();
        restoreVolume();
        sleepMode = "off";
        sleepEndsAt = 0;
        player.setPauseAtEndOfMediaItems(false);
        emitSleep();
    }

    private void emitSleep() {
        JSONObject o = new JSONObject();
        try {
            o.put("mode", sleepMode);
            o.put("endsAt", sleepEndsAt);
        } catch (JSONException ignored) {
        }
        if (sink != null) sink.emit("sleep", o);
    }

    // ---- position: overlay line, progress, events ----

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            updateOverlay();
            long now = System.currentTimeMillis();
            if ("time".equals(sleepMode) && sleepEndsAt > 0) {
                long left = sleepEndsAt - now;
                if (left <= 0) sleepDone();
                else if (left < FADE_MS) player.setVolume(baseVolume * left / FADE_MS);
            }
            if (now - lastSave > SAVE_EVERY_MS) save();
            // the app on screen follows every tick; in the background once a second
            if (overlay.appVisible || ++ticks % 4 == 0) emitState();
            if (player.isPlaying()) main.postDelayed(this, TICK_MS);
        }
    };

    private void startTick() {
        main.removeCallbacks(tick);
        main.post(tick);
    }

    private int cueAt(Cues c, double t) {
        int lo = 0, hi = c.s.length - 1, found = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (c.s[mid] <= t) {
                found = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return found >= 0 && t < c.e[found] ? found : -1;
    }

    private String lineOf(@Nullable Cues c, double t) {
        if (c == null) return "";
        int i = cueAt(c, t);
        return i >= 0 ? c.t[i] : "";
    }

    private void updateOverlay() {
        int i = player.getCurrentMediaItemIndex();
        if (i < 0 || i >= items.size() || "off".equals(subMode)) {
            overlay.setLines("", "");
            return;
        }
        Item it = items.get(i);
        double t = player.getCurrentPosition() / 1000.0 - it.offset;
        Cues main0, second = null;
        if ("original".equals(subMode)) main0 = it.orig != null ? it.orig : it.trans;
        else if ("translation".equals(subMode)) main0 = it.trans != null ? it.trans : it.orig;
        else if (it.orig != null && it.trans != null) {
            main0 = it.orig;
            second = it.trans;
        } else main0 = it.orig != null ? it.orig : it.trans;
        overlay.setLines(lineOf(main0, t), lineOf(second, t));
    }

    // Progress of the item playing, kept here until JS takes it (drain) —
    // JS may not run while the app is in the background.
    private void save() {
        lastSave = System.currentTimeMillis();
        int i = player == null ? -1 : player.getCurrentMediaItemIndex();
        if (i < 0 || i >= items.size()) return;
        long d = player.getDuration();
        record(items.get(i).key, player.getCurrentPosition() / 1000.0, d == C.TIME_UNSET ? -1 : d / 1000.0);
    }

    private void record(String key, double pos, double dur) {
        try {
            JSONObject all = new JSONObject(prefs.getString("progress", "{}"));
            JSONObject p = new JSONObject();
            p.put("p", pos);
            p.put("d", dur);
            p.put("t", System.currentTimeMillis());
            all.put(key, p);
            prefs.edit().putString("progress", all.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    // Length of a queue item the player has loaded (s), -1 = not known.
    private double durationOf(int index) {
        androidx.media3.common.Timeline tl = player.getCurrentTimeline();
        if (index < 0 || index >= tl.getWindowCount()) return -1;
        long d = tl.getWindow(index, new androidx.media3.common.Timeline.Window()).getDurationMs();
        return d == C.TIME_UNSET ? -1 : d / 1000.0;
    }

    // Progress recorded since the last call (then forgotten here).
    JSONObject drain() {
        save();
        String s = prefs.getString("progress", "{}");
        prefs.edit().remove("progress").apply();
        try {
            return new JSONObject(s);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            int i = player.getCurrentMediaItemIndex();
            o.put("index", items.isEmpty() ? -1 : i);
            o.put("key", i >= 0 && i < items.size() ? items.get(i).key : JSONObject.NULL);
            JSONArray keys = new JSONArray();
            for (Item it : items) keys.put(it.key);
            o.put("keys", keys);
            o.put("position", player.getCurrentPosition() / 1000.0);
            long d = player.getDuration();
            o.put("duration", d == C.TIME_UNSET ? 0 : d / 1000.0);
            o.put("playing", player.isPlaying());
            o.put("ended", player.getPlaybackState() == Player.STATE_ENDED);
            o.put("overlayAllowed", SubOverlay.allowed(this));
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void emitState() {
        if (sink != null) sink.emit("player", state());
    }

    void emitOverlay() {
        JSONObject o = new JSONObject();
        try {
            o.put("enabled", overlay.enabled);
            o.put("locked", overlay.locked);
            o.put("size", overlay.size);
            o.put("allowed", SubOverlay.allowed(this));
        } catch (JSONException ignored) {
        }
        if (sink != null) sink.emit("overlay", o);
    }

    private final class Listener implements Player.Listener {
        @Override
        public void onIsPlayingChanged(boolean playing) {
            if (playing) startTick();
            else {
                save();
                emitState();
            }
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            // the track that ended counts as heard to the end
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                int prev = player.getPreviousMediaItemIndex();
                if (player.getRepeatMode() == Player.REPEAT_MODE_ONE) prev = player.getCurrentMediaItemIndex();
                if (prev >= 0 && prev < items.size()) record(items.get(prev).key, Double.MAX_VALUE, durationOf(prev));
            }
            pauseAtEnd();
            updateOverlay();
            emitState();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            // paused at the end of the track by the sleep timer
            if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM && !"off".equals(sleepMode)) sleepDone();
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_ENDED) {
                int i = player.getCurrentMediaItemIndex();
                if (i >= 0 && i < items.size()) record(items.get(i).key, Double.MAX_VALUE, durationOf(i));
                if (!"off".equals(sleepMode)) sleepDone();
            }
            emitState();
        }

        @Override
        public void onPositionDiscontinuity(@NonNull Player.PositionInfo a, @NonNull Player.PositionInfo b, int reason) {
            updateOverlay();
            emitState();
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException e) {
            JSONObject o = new JSONObject();
            try {
                o.put("message", e.getErrorCodeName());
            } catch (JSONException ignored) {
            }
            if (sink != null) sink.emit("error", o);
        }
    }
}
