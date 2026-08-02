/** Positive, contractor-friendly quotes that rotate by calendar day. */
export type DailyQuote = {
  text: string;
  author?: string;
};

const QUOTES: DailyQuote[] = [
  { text: 'Every great job starts with a clear plan. You’ve got this today.' },
  { text: 'Show up, stay consistent, and the results will follow.' },
  { text: 'Small progress every day still builds a big business.' },
  { text: 'Your next estimate could open the door to your next best client.' },
  { text: 'Professionals don’t wait for motivation — they build habits.' },
  { text: 'Do the work with pride. Quality always finds its way back to you.' },
  { text: 'A good day is one where you moved a job, a client, or yourself forward.' },
  { text: 'Be the contractor clients trust — start with how you show up today.' },
  { text: 'Clarity beats chaos. One solid plan beats ten scattered thoughts.' },
  { text: 'You don’t have to do everything today. Just do the next right thing.' },
  { text: 'Excellence is a habit. So is cutting corners — choose well today.' },
  { text: 'Hard work looks ordinary up close. Keep going anyway.' },
  { text: 'Your reputation is built one job, one message, one promise at a time.' },
  { text: 'The best tool you have today is a focused mind and a clear estimate.' },
  { text: 'Success is rarely loud. It’s usually quiet consistency.' },
  { text: 'Treat today like it matters — because your clients will feel it.' },
  { text: 'You grow when you take on the job that stretches you a little.' },
  { text: 'Finish strong on what you start. That habit builds empires.' },
  { text: 'Confidence comes after action, not before it. Start moving.' },
  { text: 'Be kind to your future self: organize the job before it organizes you.' },
  { text: 'A fair price and a clear scope is respect for you and your client.' },
  { text: 'Obstacles are part of the trade. Solutions are your craft.' },
  { text: 'Today is another chance to run your business like a pro.' },
  { text: 'Protect your time. Protect your craft. Protect your energy.' },
  { text: 'The right clients find the contractors who act with integrity.' },
  { text: 'Don’t chase perfect. Chase done well, then improve tomorrow.' },
  { text: 'Your calm under pressure is a competitive advantage.' },
  { text: 'Build systems so your talent can shine without burnout.' },
  { text: 'Every invoice paid is proof you create real value.' },
  { text: 'Lead your day — don’t let the day lead you.' },
  { text: 'Good communication turns stress into trust.' },
  { text: 'You’re not just fixing problems — you’re building a name.' },
  { text: 'Discipline is doing the important work when no one is watching.' },
  { text: 'A positive attitude doesn’t fix a leak, but it wins the room.' },
  { text: 'Plan the job, work the plan, and leave the site better than you found it.' },
  { text: 'Hustle with purpose. Rest with intention. Repeat.' },
  { text: 'Your standards are your brand. Raise them gently every week.' },
  { text: 'The market rewards people who make decisions and follow through.' },
  { text: 'Be proud of the craft. Be proud of the process. Be proud of today.' },
  { text: 'Momentum loves action. Take one strong step before noon.' },
  { text: 'You are capable of more than yesterday’s doubts suggest.' },
  { text: 'Customers remember how you made them feel. Lead with respect.' },
  { text: 'Organize once, execute faster, finish cleaner.' },
  { text: 'Pressure is a privilege — it means people trust you with real work.' },
  { text: 'Make today count. Future-you is already cheering you on.' },
  { text: 'Skill opens doors. Character keeps them open.' },
  { text: 'Don’t wait for the perfect day. Make this one productive.' },
  { text: 'A clear estimate is a promise of professionalism.' },
  { text: 'Keep learning. The best tradespeople stay curious forever.' },
  { text: 'Gratitude and grit make a powerful team. Use both today.' },
  { text: 'Your business grows at the speed of your follow-through.' },
  { text: 'Start where you are. Use what you have. Do what you can.', author: 'Arthur Ashe' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'Quality is not an act, it is a habit.', author: 'Aristotle' },
  { text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
  { text: 'It always seems impossible until it’s done.', author: 'Nelson Mandela' },
  { text: 'Success is the sum of small efforts repeated day in and day out.', author: 'Robert Collier' },
  { text: 'Believe you can and you’re halfway there.', author: 'Theodore Roosevelt' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Opportunities don’t happen. You create them.', author: 'Chris Grosser' },
  { text: 'Don’t watch the clock; do what it does. Keep going.', author: 'Sam Levenson' },
  { text: 'What you do today can improve all your tomorrows.', author: 'Ralph Marston' },
  { text: 'Act as if what you do makes a difference. It does.', author: 'William James' },
  { text: 'Great things are done by a series of small things brought together.', author: 'Vincent van Gogh' },
  { text: 'Fall seven times, stand up eight.', author: 'Japanese proverb' },
  { text: 'Energy and persistence conquer all things.', author: 'Benjamin Franklin' },
];

/** Stable day index (UTC date) so the quote changes once per calendar day. */
export function getDayIndex(date: Date = new Date()): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  // Days since a fixed epoch — stable across reloads the same day
  return Math.floor(Date.UTC(y, m, d) / 86_400_000);
}

export function getQuoteOfTheDay(date: Date = new Date()): DailyQuote {
  const idx = getDayIndex(date) % QUOTES.length;
  return QUOTES[idx < 0 ? idx + QUOTES.length : idx];
}
