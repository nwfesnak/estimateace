import { redirect } from 'next/navigation';

/** Deep link: /login → main app (login form). */
export default function LoginPage() {
  redirect('/');
}
