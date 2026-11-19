import UIKit
import Capacitor

/// Capacitor bridge + EstimateAce's own native plugins (compiled into the app target,
/// not npm packages): RoomScanPlugin (LiDAR room scan).
class EstimateAceBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RoomScanPlugin())
    }
}
