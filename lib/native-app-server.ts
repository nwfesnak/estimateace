import { NextResponse } from 'next/server';
import { isNativeUserAgent, NATIVE_MANAGE_PLAN_TEXT } from '@/lib/native-app-shared';

/** Request came from the EstimateAce iOS / Android app (user-agent token). */
export function isNativeAppRequest(request: Request): boolean {
  return isNativeUserAgent(request.headers.get('user-agent'));
}

/**
 * Backstop for the store rules: the app never starts a purchase of the EstimateAce plan,
 * add-ons or crew seats (Apple 3.1.1 / Google Play payments). Returns a 403 response for
 * app requests, or null on the web.
 */
export function refuseInAppPurchase(request: Request): NextResponse | null {
  if (!isNativeAppRequest(request)) return null;
  return NextResponse.json(
    { error: NATIVE_MANAGE_PLAN_TEXT, code: 'native_app_purchase_unavailable' },
    { status: 403 }
  );
}
