import Foundation
import UIKit
import Capacitor
#if canImport(RoomPlan)
import RoomPlan
#endif

/// EstimateAce LiDAR room scan (Apple RoomPlan, iOS 16+, LiDAR iPhone / iPad Pro).
///
/// JS name: "RoomScan" (see lib/room-scan.ts)
///   isSupported() -> { supported: Bool }
///   scanRoom()    -> { floorSqft, wallSqft, grossWallSqft, perimeterLf, ceilingFt,
///                      walls: [{ widthFt, heightFt }], doors, windows, openings,
///                      openingSqft, floorAreaSource: "floor" | "walls" }
/// Rejects with code "UNSUPPORTED", "CANCELED", "BUSY" or "SCAN_FAILED".
/// Registered in EstimateAceBridgeViewController.capacitorDidLoad().
@objc(RoomScanPlugin)
public class RoomScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomScanPlugin"
    public let jsName = "RoomScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanRoom", returnType: CAPPluginReturnPromise),
    ]

    private var scanInProgress = false

    static var deviceSupported: Bool {
        #if canImport(RoomPlan)
        if #available(iOS 16.0, *) {
            return RoomCaptureSession.isSupported
        }
        #endif
        return false
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": RoomScanPlugin.deviceSupported])
    }

    @objc func scanRoom(_ call: CAPPluginCall) {
        #if canImport(RoomPlan)
        guard #available(iOS 16.0, *) else {
            call.reject("Room scanning needs iOS 16 or later.", "UNSUPPORTED")
            return
        }
        guard RoomCaptureSession.isSupported else {
            call.reject("This device has no LiDAR scanner. Enter measurements instead.", "UNSUPPORTED")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard !self.scanInProgress else {
                call.reject("A room scan is already open.", "BUSY")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("Could not open the scanner.", "SCAN_FAILED")
                return
            }
            self.scanInProgress = true
            let scanner = RoomScanViewController()
            scanner.modalPresentationStyle = .fullScreen
            scanner.onFinish = { [weak self] outcome in
                self?.scanInProgress = false
                switch outcome {
                case .success(let room):
                    call.resolve(RoomScanMeasure.summary(of: room))
                case .canceled:
                    call.reject("Scan canceled.", "CANCELED")
                case .failure(let message):
                    call.reject(message, "SCAN_FAILED")
                }
            }
            presenter.present(scanner, animated: true)
        }
        #else
        call.reject("Room scanning is not available in this build.", "UNSUPPORTED")
        #endif
    }
}

#if canImport(RoomPlan)

@available(iOS 16.0, *)
enum RoomScanOutcome {
    case success(CapturedRoom)
    case canceled
    case failure(String)
}

/// Full-screen RoomPlan scanner with Apple's built-in coaching UI.
/// Cancel = close without a result. Done = stop, let RoomPlan finish the model, return it.
@available(iOS 16.0, *)
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
    var onFinish: ((RoomScanOutcome) -> Void)?

    private var roomCaptureView: RoomCaptureView!
    private let configuration = RoomCaptureSession.Configuration()
    private var finished = false
    private var stopping = false
    private let doneButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private let hint = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        roomCaptureView = RoomCaptureView(frame: view.bounds)
        roomCaptureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        roomCaptureView.captureSession.delegate = self
        roomCaptureView.delegate = self
        view.addSubview(roomCaptureView)

        style(cancelButton, title: "Cancel", filled: false)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        style(doneButton, title: "Done", filled: true)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

        hint.text = "Slowly walk the room and point at every wall, door and window."
        hint.textColor = .white
        hint.font = .systemFont(ofSize: 15, weight: .medium)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        hint.layer.cornerRadius = 10
        hint.clipsToBounds = true

        for v in [cancelButton, doneButton, hint] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancelButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            cancelButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            doneButton.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            doneButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            hint.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            hint.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        roomCaptureView.captureSession.run(configuration: configuration)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if !stopping { roomCaptureView.captureSession.stop() }
    }

    private func style(_ b: UIButton, title: String, filled: Bool) {
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
        b.layer.cornerRadius = 20
        b.setTitleColor(.white, for: .normal)
        b.backgroundColor = filled
            ? UIColor(red: 0.06, green: 0.73, blue: 0.51, alpha: 1)
            : UIColor.black.withAlphaComponent(0.45)
    }

    @objc private func cancelTapped() {
        stopping = true
        roomCaptureView.captureSession.stop()
        finish(.canceled)
    }

    @objc private func doneTapped() {
        guard !stopping else { return }
        stopping = true
        doneButton.isEnabled = false
        doneButton.setTitle("Measuring…", for: .normal)
        hint.text = "Building your room measurements…"
        // RoomPlan finishes processing, then calls captureView(didPresent:error:).
        roomCaptureView.captureSession.stop()
    }

    private func finish(_ outcome: RoomScanOutcome) {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) { [onFinish] in onFinish?(outcome) }
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error = error {
            finish(.failure("Scan failed: \(error.localizedDescription)"))
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error = error {
            finish(.failure("Scan failed: \(error.localizedDescription)"))
            return
        }
        guard !processedResult.walls.isEmpty else {
            finish(.failure("No walls were found. Try again and point the phone at each wall."))
            return
        }
        finish(.success(processedResult))
    }

    // MARK: RoomCaptureSessionDelegate

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        if let error = error, !stopping {
            finish(.failure("Scan stopped: \(error.localizedDescription)"))
        }
    }
}

/// Turns a CapturedRoom into feet / square feet the estimate uses.
@available(iOS 16.0, *)
enum RoomScanMeasure {
    static let ftPerM: Float = 3.28084
    static let sqftPerSqm: Float = 10.7639

    static func summary(of room: CapturedRoom) -> [String: Any] {
        let walls = room.walls
        var grossWallSqm: Float = 0
        var perimeterM: Float = 0
        var ceilingM: Float = 0
        var wallList: [[String: Any]] = []
        for w in walls {
            let width = w.dimensions.x
            let height = w.dimensions.y
            grossWallSqm += width * height
            perimeterM += width
            ceilingM = max(ceilingM, height)
            wallList.append(["widthFt": round1(width * ftPerM), "heightFt": round1(height * ftPerM)])
        }
        let openingSurfaces = room.doors + room.windows + room.openings
        let openingSqm = openingSurfaces.reduce(Float(0)) { $0 + $1.dimensions.x * $1.dimensions.y }
        let netWallSqm = max(0, grossWallSqm - openingSqm)

        var floorSqm: Float = 0
        var floorSource = "walls"
        if #available(iOS 17.0, *), !room.floors.isEmpty {
            floorSqm = room.floors.reduce(Float(0)) { $0 + surfaceArea($1) }
            floorSource = "floor"
        }
        if floorSqm <= 0 {
            floorSqm = hullAreaFromWalls(walls)
            floorSource = "walls"
        }

        return [
            "floorSqft": round1(floorSqm * sqftPerSqm),
            "wallSqft": round1(netWallSqm * sqftPerSqm),
            "grossWallSqft": round1(grossWallSqm * sqftPerSqm),
            "perimeterLf": round1(perimeterM * ftPerM),
            "ceilingFt": round1(ceilingM * ftPerM),
            "walls": wallList,
            "doors": room.doors.count,
            "windows": room.windows.count,
            "openings": room.openings.count,
            "openingSqft": round1(openingSqm * sqftPerSqm),
            "floorAreaSource": floorSource,
        ]
    }

    /// iOS 17 floor surface: polygon corners (local space) → shoelace; else bounding size.
    @available(iOS 17.0, *)
    static func surfaceArea(_ s: CapturedRoom.Surface) -> Float {
        let corners = s.polygonCorners
        if corners.count >= 3 {
            let xy = shoelace(corners.map { SIMD2<Float>($0.x, $0.y) })
            let xz = shoelace(corners.map { SIMD2<Float>($0.x, $0.z) })
            let area = max(xy, xz)
            if area > 0 { return area }
        }
        return s.dimensions.x * max(s.dimensions.y, s.dimensions.z)
    }

    /// iOS 16: floor ≈ convex hull of the wall end points seen from above (good for
    /// rectangles; slightly high for L-shaped rooms — editable in the app).
    static func hullAreaFromWalls(_ walls: [CapturedRoom.Surface]) -> Float {
        var points: [SIMD2<Float>] = []
        for w in walls {
            let t = w.transform
            let center = SIMD2<Float>(t.columns.3.x, t.columns.3.z)
            var dir = SIMD2<Float>(t.columns.0.x, t.columns.0.z)
            let len = (dir.x * dir.x + dir.y * dir.y).squareRoot()
            if len > 0 { dir /= len }
            let half = dir * (w.dimensions.x / 2)
            points.append(center + half)
            points.append(center - half)
        }
        return shoelace(convexHull(points))
    }

    static func shoelace(_ p: [SIMD2<Float>]) -> Float {
        guard p.count >= 3 else { return 0 }
        var sum: Float = 0
        for i in 0..<p.count {
            let a = p[i], b = p[(i + 1) % p.count]
            sum += a.x * b.y - b.x * a.y
        }
        return abs(sum) / 2
    }

    /// Andrew's monotone chain.
    static func convexHull(_ pts: [SIMD2<Float>]) -> [SIMD2<Float>] {
        let p = pts.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard p.count >= 3 else { return p }
        func cross(_ o: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float {
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        }
        var lower: [SIMD2<Float>] = []
        for pt in p {
            while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], pt) <= 0 { lower.removeLast() }
            lower.append(pt)
        }
        var upper: [SIMD2<Float>] = []
        for pt in p.reversed() {
            while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], pt) <= 0 { upper.removeLast() }
            upper.append(pt)
        }
        lower.removeLast()
        upper.removeLast()
        return lower + upper
    }

    static func round1(_ v: Float) -> Double {
        (Double(v) * 10).rounded() / 10
    }
}

#endif
