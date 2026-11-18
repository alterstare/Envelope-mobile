package com.alterstare.envelope;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

// 떠 있는 자막: the subtitle lines in a small window over other apps (no
// picture-in-picture — just the text). Same look as Envelope's subtitle strip
// over the bottom bar: each line its own dark rounded box, white 600 text, the
// translation 0.85× in light purple.
//
// Unlocked: drag it up / down; a tap shows [작게] [크게] [잠금] [닫기].
// Locked: touches go through to the app below (the window can't be touched at
// all; Android 12+ passes touches through only windows at most 80% opaque, so
// a locked window is drawn at 0.8). Unlock from the app or the notification.
final class SubOverlay {
    interface Listener {
        void changed(); // closed / locked / size changed by touch
    }

    private static final int TOOLS_MS = 4000;
    private static final float MAX_ALPHA_LOCKED = 0.8f;

    private final Context ctx;
    private final WindowManager wm;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;

    private FrameLayout root;
    private LinearLayout box;
    private TextView l1, l2;
    private ImageView idle;
    private LinearLayout tools;
    private ImageButton lockBtn;
    private WindowManager.LayoutParams lp;
    private boolean added;

    // what JS / the user asked for
    boolean enabled; // 떠 있는 자막 켜짐
    boolean locked;
    boolean hideInApp = true;
    boolean appVisible;
    boolean hasMedia;
    float size = 18; // sp
    float opacity = 0.86f; // box background
    private String a = "", b = "";

    SubOverlay(Context ctx, Listener listener) {
        this.ctx = ctx;
        this.listener = listener;
        this.wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        this.prefs = ctx.getSharedPreferences("overlay", Context.MODE_PRIVATE);
    }

    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics()));
    }

    private boolean shouldShow() {
        return enabled && hasMedia && allowed(ctx) && !(hideInApp && appVisible);
    }

    // Lines on screen now ("" = none).
    void setLines(String first, String second) {
        first = first == null ? "" : first;
        second = second == null ? "" : second;
        if (first.equals(a) && second.equals(b)) return;
        a = first;
        b = second;
        if (added) render();
    }

    // Settings changed / app shown or hidden: add, update or remove the window.
    void apply() {
        if (!shouldShow()) {
            remove();
            return;
        }
        if (!added) add();
        else {
            updateFlags();
            render();
        }
    }

    private GradientDrawable pill() {
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(10));
        d.setColor(Color.argb(Math.round(opacity * 255), 10, 11, 16));
        return d;
    }

    private TextView line(boolean second) {
        TextView t = new TextView(ctx);
        t.setTextColor(second ? 0xFFE3DCFF : Color.WHITE);
        t.setTypeface(Build.VERSION.SDK_INT >= 28 ? Typeface.create(Typeface.SANS_SERIF, 600, false) : Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setLineSpacing(0, 1.15f);
        t.setPadding(dp(14), dp(5), dp(14), dp(5));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.gravity = Gravity.CENTER_HORIZONTAL;
        if (second) p.topMargin = dp(3);
        t.setLayoutParams(p);
        return t;
    }

    private ImageButton tool(int icon, String label, View.OnClickListener on) {
        ImageButton b = new ImageButton(ctx);
        b.setImageResource(icon);
        b.setContentDescription(label);
        b.setScaleType(ImageView.ScaleType.CENTER);
        TypedValue tv = new TypedValue();
        ctx.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true);
        b.setBackgroundResource(tv.resourceId);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(36)));
        b.setOnClickListener((v) -> {
            on.onClick(v);
            showTools(); // keep the row while it's being used
        });
        return b;
    }

    // Flat group divider (Halftone .flat-group): 1px × 14px between buttons.
    private View divider() {
        View v = new View(ctx);
        v.setBackgroundColor(0x40FFFFFF);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(1), dp(14));
        p.gravity = Gravity.CENTER_VERTICAL;
        v.setLayoutParams(p);
        return v;
    }

    private void build() {
        root = new FrameLayout(ctx);
        box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(box, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL));
        l1 = line(false);
        l2 = line(true);
        idle = new ImageView(ctx);
        idle.setImageResource(R.drawable.ic_graphic_eq);
        idle.setAlpha(0.7f);
        idle.setPadding(dp(14), dp(5), dp(14), dp(5));
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30));
        ip.gravity = Gravity.CENTER_HORIZONTAL;
        idle.setLayoutParams(ip);
        tools = new LinearLayout(ctx);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        tools.setPadding(dp(4), 0, dp(4), 0);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tp.gravity = Gravity.CENTER_HORIZONTAL;
        tp.topMargin = dp(6);
        tools.setLayoutParams(tp);
        tools.addView(tool(R.drawable.ic_text_decrease, "글자 작게", (v) -> setSizeByTouch(size - 2)));
        tools.addView(divider());
        tools.addView(tool(R.drawable.ic_text_increase, "글자 크게", (v) -> setSizeByTouch(size + 2)));
        tools.addView(divider());
        lockBtn = tool(R.drawable.ic_lock_open, "잠금", (v) -> {
            locked = true;
            hideTools();
            apply();
            listener.changed();
        });
        tools.addView(lockBtn);
        tools.addView(divider());
        tools.addView(tool(R.drawable.ic_close, "떠 있는 자막 닫기", (v) -> {
            enabled = false;
            apply();
            listener.changed();
        }));
        tools.setVisibility(View.GONE);
        box.addView(l1);
        box.addView(l2);
        box.addView(idle);
        box.addView(tools);
        root.setOnTouchListener(new Drag());
    }

    private void setSizeByTouch(float v) {
        size = Math.max(12, Math.min(40, v));
        render();
        listener.changed();
    }

    private final Runnable hideToolsLater = this::hideTools;

    private void showTools() {
        tools.setVisibility(View.VISIBLE);
        main.removeCallbacks(hideToolsLater);
        main.postDelayed(hideToolsLater, TOOLS_MS);
        render();
    }

    private void hideTools() {
        main.removeCallbacks(hideToolsLater);
        if (tools != null) tools.setVisibility(View.GONE);
        if (added) render();
    }

    private void render() {
        boolean any = !a.isEmpty() || !b.isEmpty();
        boolean toolsOn = tools.getVisibility() == View.VISIBLE;
        int maxW = ctx.getResources().getDisplayMetrics().widthPixels - dp(24);
        for (TextView t : new TextView[] {l1, l2}) {
            t.setMaxWidth(maxW);
            t.setBackground(pill());
        }
        l1.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        l2.setTextSize(TypedValue.COMPLEX_UNIT_SP, size * 0.85f);
        l1.setText(a);
        l2.setText(b);
        l1.setVisibility(a.isEmpty() ? View.GONE : View.VISIBLE);
        l2.setVisibility(b.isEmpty() ? View.GONE : View.VISIBLE);
        if (l2.getVisibility() == View.VISIBLE) ((LinearLayout.LayoutParams) l2.getLayoutParams()).topMargin = a.isEmpty() ? 0 : dp(3);
        // nothing being said: a small handle while it can be moved, nothing when locked
        idle.setBackground(pill());
        idle.setVisibility(!any && !locked ? View.VISIBLE : View.GONE);
        tools.setBackground(pill());
        lockBtn.setImageResource(locked ? R.drawable.ic_lock : R.drawable.ic_lock_open);
        box.setVisibility(any || !locked || toolsOn ? View.VISIBLE : View.GONE);
    }

    private int defaultY() {
        DisplayMetrics m = ctx.getResources().getDisplayMetrics();
        return Math.round(m.heightPixels * 0.68f);
    }

    private void updateFlags() {
        int f = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        if (locked) f |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        lp.flags = f;
        lp.alpha = locked && Build.VERSION.SDK_INT >= 31 ? MAX_ALPHA_LOCKED : 1f;
        if (locked) hideTools();
        if (added) wm.updateViewLayout(root, lp);
    }

    private void add() {
        if (root == null) build();
        lp = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE,
            0,
            PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        lp.y = prefs.getInt("y", defaultY());
        updateFlags();
        render();
        try {
            wm.addView(root, lp);
            added = true;
        } catch (RuntimeException e) {
            added = false; // permission taken away meanwhile
        }
    }

    void remove() {
        hideTools();
        if (!added) return;
        try {
            wm.removeView(root);
        } catch (RuntimeException ignored) {
        }
        added = false;
    }

    // Vertical drag moves the window (kept inside the screen); a tap toggles the tools.
    private final class Drag implements View.OnTouchListener {
        private float downY;
        private int startY;
        private boolean moving;
        private final int slop = ViewConfiguration.get(ctx).getScaledTouchSlop();

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downY = e.getRawY();
                    startY = lp.y;
                    moving = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dy = e.getRawY() - downY;
                    if (!moving && Math.abs(dy) > slop) moving = true;
                    if (moving) {
                        int max = ctx.getResources().getDisplayMetrics().heightPixels - root.getHeight();
                        lp.y = Math.max(0, Math.min(max, Math.round(startY + dy)));
                        wm.updateViewLayout(root, lp);
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    if (moving) prefs.edit().putInt("y", lp.y).apply();
                    else if (tools.getVisibility() == View.VISIBLE) hideTools();
                    else showTools();
                    return true;
                default:
                    return false;
            }
        }
    }
}
