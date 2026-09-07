import { redirect } from 'next/navigation';

/** Deep link: /pricing → trial/plan chooser (marketing site has full pricing HTML). */
export default function PricingPage() {
  redirect('/trial');
}
