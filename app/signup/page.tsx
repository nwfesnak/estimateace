import { redirect } from 'next/navigation';

/** Deep link: /signup → free trial & plan page. */
export default function SignupPage() {
  redirect('/trial');
}
