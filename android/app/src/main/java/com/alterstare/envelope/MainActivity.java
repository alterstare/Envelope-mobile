package com.alterstare.envelope;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Page background + the system bars (their area shows the window
    // background; icons dark on light, light on dark).
    static void applyTheme(android.app.Activity act, android.webkit.WebView web, boolean dark) {
        int bg = dark ? 0xFF14161D : 0xFFFFFFFF;
        web.setBackgroundColor(dark ? 0xFF0B0D13 : 0xFFF4F5F8);
        act.getWindow().getDecorView().setBackgroundColor(bg);
        //noinspection deprecation
        act.getWindow().setStatusBarColor(bg);
        //noinspection deprecation
        act.getWindow().setNavigationBarColor(dark ? 0xFF14161D : 0xFFFFFFFF);
        androidx.core.view.WindowInsetsControllerCompat c = new androidx.core.view.WindowInsetsControllerCompat(act.getWindow(), act.getWindow().getDecorView());
        c.setAppearanceLightStatusBars(!dark);
        c.setAppearanceLightNavigationBars(!dark);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EnvPlugin.class);
        super.onCreate(savedInstanceState);
        // Serve /_s/… urls (covers, pictures, the 모바일 정보 파일, subtitle files).
        bridge.setWebViewClient(new EnvWebViewClient(bridge));
        bridge.getWebView().getSettings().setSupportZoom(false);
        bridge.getWebView().getSettings().setBuiltInZoomControls(false);
        // Last theme (EnvPlugin.setTheme) as the page background before it loads.
        boolean dark = getSharedPreferences("envelope", MODE_PRIVATE).getBoolean("dark", false);
        applyTheme(this, bridge.getWebView(), dark);
        // Back: the app's own navigation (JS decides whether to step back or leave).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                EnvPlugin p = EnvPlugin.instance;
                if (p != null && p.handleBack()) return;
                // Leaving keeps playback (the service and its notification stay).
                moveTaskToBack(true);
            }
        });
    }

    // Notification permission (asked at the first play) denied → say once
    // where the controls went.
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == EnvPlugin.NOTIFY_REQ && grantResults.length > 0
            && grantResults[0] != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            android.widget.Toast.makeText(this,
                "알림 권한이 꺼져 있어 재생 알림이 보이지 않습니다. 재생은 계속되며, 휴대폰 설정 › 앱 › Envelope › 알림에서 켤 수 있습니다.",
                android.widget.Toast.LENGTH_LONG).show();
        }
    }
}
