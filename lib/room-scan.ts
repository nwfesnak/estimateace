/**
 * LiDAR room scan (iPhone Pro / iPad Pro with LiDAR, iOS 16+), via the small native
 * Capacitor plugin in ios/App/App/RoomScanPlugin.swift (Apple RoomPlan).
 *
 * Everywhere else (web, Android, iPhones without LiDAR, older app builds without the
 * plugin) isRoomScanAvailable() is false and the UI shows manual measurements instead.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { RoomMeasurements } from '@/lib/photo-estimate';

/** Raw result from the native plugin (feet / square feet, already converted). */
export type RoomScanResult = {
  floorSqft: number;
  wallSqft: number;
  grossWallSqft: number;
  perimeterLf: number;
  ceilingFt: number;
  walls: Array<{ widthFt: number; heightFt: number }>;
  doors: number;
  windows: number;
  openings: number;
  openingSqft: number;
  floorAreaSource: 'floor' | 'walls';
};

type RoomScanPlugin = {
  isSupported(): Promise<{ supported: boolean }>;
  scanRoom(): Promise<RoomScanResult>;
};

const RoomScan = registerPlugin<RoomScanPlugin>('RoomScan');

/** True only inside the iOS app on a LiDAR device with the plugin compiled in. */
export async function isRoomScanAvailable(): Promise<boolean> {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return false;
    if (!Capacitor.isPluginAvailable('RoomScan')) return false;
    const { supported } = await RoomScan.isSupported();
    return supported === true;
  } catch {
    return false;
  }
}

/** Opens the native scanner. Rejects with code "CANCELED" if the user closes it. */
export function scanRoom(): Promise<RoomScanResult> {
  return RoomScan.scanRoom();
}

const r1 = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : undefined;
};

/** Scan → the measurement shape the photo estimate uses. */
export function scanToMeasurements(scan: Partial<RoomScanResult>): RoomMeasurements {
  return {
    floorSqft: r1(scan.floorSqft),
    wallSqft: r1(scan.wallSqft),
    perimeterLf: r1(scan.perimeterLf),
    ceilingFt: r1(scan.ceilingFt),
    doors: Number(scan.doors) > 0 ? Math.round(Number(scan.doors)) : undefined,
    windows: Number(scan.windows) > 0 ? Math.round(Number(scan.windows)) : undefined,
    source: 'lidar',
  };
}

/**
 * Manual fallback: length × width × ceiling height (feet) → floor, walls, perimeter.
 * Doors (~21 sq ft) and windows (~15 sq ft) are taken off the wall area.
 */
export function manualMeasurements(input: {
  lengthFt?: number;
  widthFt?: number;
  ceilingFt?: number;
  doors?: number;
  windows?: number;
}): RoomMeasurements | null {
  const L = Number(input.lengthFt) || 0;
  const W = Number(input.widthFt) || 0;
  if (L <= 0 || W <= 0) return null;
  const H = Number(input.ceilingFt) > 0 ? Number(input.ceilingFt) : 8;
  const doors = Math.max(0, Math.round(Number(input.doors) || 0));
  const windows = Math.max(0, Math.round(Number(input.windows) || 0));
  const perimeter = 2 * (L + W);
  const walls = Math.max(0, perimeter * H - doors * 21 - windows * 15);
  return {
    floorSqft: r1(L * W),
    wallSqft: r1(walls),
    perimeterLf: r1(perimeter),
    ceilingFt: r1(H),
    doors: doors || undefined,
    windows: windows || undefined,
    source: 'manual',
  };
}
