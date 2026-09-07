import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Welcome to EstimateAce',
  description: 'Private walkthrough video for new EstimateAce users.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
