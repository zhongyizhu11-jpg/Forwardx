import Capacitor
import WebKit

final class ForwardXViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        Self.allowFullRefreshRate(configuration.preferences)
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }

    /// ProMotion (120Hz): WebKit caps page rendering updates (requestAnimationFrame,
    /// CSS animations and transitions) near 60fps by default. Info.plist sets
    /// CADisableMinimumFrameDurationOnPhone so the app may draw above 60Hz; this turns
    /// off WebKit's own 60fps preference. The setter is not public API, so it is called
    /// only when this WebKit build exposes it; otherwise nothing changes (60fps, as before).
    private static func allowFullRefreshRate(_ preferences: WKPreferences) {
        let selector = NSSelectorFromString("_setPreferPageRenderingUpdatesNear60FPSEnabled:")
        guard preferences.responds(to: selector),
              let implementation = preferences.method(for: selector) else { return }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(implementation, to: Setter.self)(preferences, selector, false)
    }
}
