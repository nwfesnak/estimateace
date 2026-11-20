import type { Metadata } from 'next';
import { AppointmentConfirmClient } from './ConfirmClient';

export const metadata: Metadata = {
  title: 'Confirm appointment | EstimateAce',
  description: 'Confirm your scheduled appointment.',
  robots: { index: false, follow: false },
};

export default function AppointmentConfirmPage() {
  return <AppointmentConfirmClient />;
}
