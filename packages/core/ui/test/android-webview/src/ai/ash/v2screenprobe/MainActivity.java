package ai.ash.v2screenprobe;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

/** An isolated local-only browser surface for cross-device UI tests. */
public final class MainActivity extends Activity {
  private WebView web;

  private static boolean allowed(Uri uri) {
    return uri != null && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
        && uri.getPort() == 14762 && ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath()));
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    Uri target = getIntent().getData();
    if (!allowed(target)) {
      TextView error = new TextView(this);
      error.setText("Only the isolated local test endpoint is allowed.");
      setContentView(error);
      return;
    }
    WebView.setWebContentsDebuggingEnabled(true);
    web = new WebView(this);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !allowed(request.getUrl());
      }
    });
    setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    web.loadUrl(target.toString());
  }

  @Override public void onDestroy() {
    if (web != null) { web.destroy(); web = null; }
    super.onDestroy();
  }
}
