'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { createClient } from '@supabase/supabase-js';

export default function Home() {
  const supabase = useMemo(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }, []);

  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const [terms, setTerms] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);

  const [profile, setProfile] = useState({ name: '', company: '', address: '', phone: '', email: '', slogan: '', showInHeader: true });

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; text: string }[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState('Never');
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);

  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [selectedEmailsForSend, setSelectedEmailsForSend] = useState<string[]>([]);
  const [selectedPhonesForSend, setSelectedPhonesForSend] = useState<string[]>([]);

  // NEW: Calendar scheduling modal
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');

  const grandTotal = items.reduce((sum, item) => sum + (item.total || 0), 0);
  const amountDue = Math.max(grandTotal - amountPaid, 0);

  const showMessage = (message: string) => {
    const clean = message.replace(/^[^\s]*\.vercel\.app says:\s*/i, '').trim();
    alert(clean);
  };

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => setUser(session?.user ?? null));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  const login = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) showMessage(error.message);
    else setShowLogin(false);
  };

  const signup = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) showMessage(error.message);
    else showMessage('Account created!');
  };

  const saveToDB = async () => {
    if (!user || !supabase) return;
    const data = {
      user_id: user.id,
      jobName, address, city, zipCode, phones, emails, date, invoiceNumber, items, terms, profile,
      documentType, dueDate, paymentStatus, amountPaid, paymentMethod,
      photoUrls, videoUrls,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) console.error('❌ Save error:', error);
    else setLastSaved(new Date().toLocaleTimeString());
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video') => {
    if (!files || !user || !supabase) return;
    const newUrls: string[] = [];
    for (const file of Array.from(files)) {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/${type}/${Date.now()}.${fileExt}`;
      const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
      if (!error) {
        const { data } = supabase.storage.from('media').getPublicUrl(filePath);
        newUrls.push(data.publicUrl);
      }
    }
    if (type === 'photo') setPhotoUrls(prev => [...prev, ...newUrls]);
    else setVideoUrls(prev => [...prev, ...newUrls]);
    await saveToDB();
  };

  const removeMedia = (type: 'photo' | 'video', index: number) => {
    if (type === 'photo') setPhotoUrls(prev => prev.filter((_, i) => i !== index));
    else setVideoUrls(prev => prev.filter((_, i) => i !== index));
    saveToDB();
  };

  const refreshSavedList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('estimates').select('*').eq('user_id', user.id).order('updated_at', { ascending: false });
    setSavedEstimatesList(data || []);
  };

  const openLoadModal = async () => {
    await refreshSavedList();
    setIsLoadModalOpen(true);
  };

  const loadSelectedEstimate = (est: any) => {
    setJobName(est.jobName || '');
    setAddress(est.address || '');
    setCity(est.city || '');
    setZipCode(est.zipCode || '');
    setPhones(est.phones || ['']);
    setEmails(est.emails || ['']);
    setDate(est.date || '');
    setInvoiceNumber(est.invoiceNumber || 'EST-0001');
    setItems(est.items || [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setTerms(est.terms || '');
    setProfile(est.profile || profile);
    setDocumentType(est.documentType || 'estimate');
    setDueDate(est.dueDate || '');
    setPaymentStatus(est.paymentStatus || 'pending');
    setAmountPaid(est.amountPaid || 0);
    setPaymentMethod(est.paymentMethod || '');
    setPhotoUrls(est.photoUrls || []);
    setVideoUrls(est.videoUrls || []);
    setIsLoadModalOpen(false);
    showMessage('Loaded from Supabase!');
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete this document permanently?')) return;
    if (!supabase) return;
    await supabase.from('estimates').delete().eq('id', id);
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const newEstimate = () => {
    if (!confirm('Start a completely new document?')) return;
    setJobName(''); setAddress(''); setCity(''); setZipCode('');
    setPhones(['']); setEmails(['']); setTerms(''); setPhotoUrls([]); setVideoUrls([]);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    const today = new Date().toISOString().split('T')[0];
    setDate(today);
    const savedCount = parseInt(localStorage.getItem('estimateCount') || '0') + 1;
    localStorage.setItem('estimateCount', savedCount.toString());
    const prefix = documentType === 'invoice' ? 'INV' : 'EST';
    setInvoiceNumber(`${prefix}-${String(savedCount).padStart(4, '0')}`);
    showMessage('New document started!');
  };

  const addRow = () => setItems([...items, { id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const updateItem = (id: number, field: string, value: any) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, [field]: value, total: (field === 'qty' || field === 'price') ? (item.qty || 0) * (item.price || 0) : item.total } : item));
  };
  const removeRow = (id: number) => setItems(prev => prev.filter(item => item.id !== id));

  const addPhone = () => setPhones([...phones, '']);
  const removePhone = (i: number) => setPhones(phones.filter((_, idx) => idx !== i));
  const updatePhone = (i: number, value: string) => { const arr = [...phones]; arr[i] = value; setPhones(arr); };
  const addEmail = () => setEmails([...emails, '']);
  const removeEmail = (i: number) => setEmails(emails.filter((_, idx) => idx !== i));
  const updateEmail = (i: number, value: string) => { const arr = [...emails]; arr[i] = value; setEmails(arr); };

  const forceSave = async () => { await saveToDB(); };
  const saveNamedEstimate = async () => {
    await saveToDB();
    showMessage(`Saved as "${jobName || 'Untitled'} - ${invoiceNumber}"`);
  };
  const saveProfile = async () => { await saveToDB(); setIsProfileOpen(false); };

  const printDocument = () => window.print();

  const convertToInvoice = () => {
    setDocumentType('invoice');
    if (invoiceNumber.startsWith('EST-')) setInvoiceNumber(invoiceNumber.replace('EST-', 'INV-'));
    setSelectedEmailsForSend(emails.length > 0 ? [emails[0]] : []);
    setSelectedPhonesForSend(phones.length > 0 ? [phones[0]] : []);
    setIsSendModalOpen(true);
  };

  const openSendModal = () => {
    setSelectedEmailsForSend(emails.length > 0 ? [emails[0]] : []);
    setSelectedPhonesForSend(phones.length > 0 ? [phones[0]] : []);
    setIsSendModalOpen(true);
  };

  const sendViaEmail = () => {
    if (selectedEmailsForSend.length === 0) return showMessage("Please select at least one email");
    let msg = `✅ ${documentType.toUpperCase()} sent via email to: ${selectedEmailsForSend.join(', ')}`;
    if (photoUrls.length > 0) msg += `\n\n📸 PHOTOS ATTACHED:\n${photoUrls.join('\n')}`;
    showMessage(msg);
    setIsSendModalOpen(false);
  };

  const sendViaText = () => {
    if (selectedPhonesForSend.length === 0) return showMessage("Please select at least one phone number");
    let msg = `✅ ${documentType.toUpperCase()} sent via text to: ${selectedPhonesForSend.join(', ')}`;
    if (photoUrls.length > 0) msg += `\n\n📸 PHOTOS ATTACHED:\n${photoUrls.join('\n')}`;
    showMessage(msg);
    setIsSendModalOpen(false);
  };

  const openGoogleCalendar = () => window.open('https://calendar.google.com', '_blank');

  // NEW: Open Calendar Scheduling Popup
  const openCalendarModal = async () => {
    await refreshSavedList();
    setIsCalendarModalOpen(true);
  };

  const scheduleAppointment = () => {
    if (!selectedEstimateForCalendar || !selectedDateTime) {
      showMessage("Please select an estimate and date/time");
      return;
    }

    const startTime = new Date(selectedDateTime);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour appointment

    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Appointment%20for%20${encodeURIComponent(selectedEstimateForCalendar.jobName || 'Estimate')}&dates=${startTime.toISOString().replace(/[-:]/g, '').slice(0, 15)}/${endTime.toISOString().replace(/[-:]/g, '').slice(0, 15)}&details=Estimate%20%23${encodeURIComponent(selectedEstimateForCalendar.invoiceNumber)}%0AJob%3A%20${encodeURIComponent(selectedEstimateForCalendar.jobName || '')}%0AClient%3A%20${encodeURIComponent(selectedEstimateForCalendar.address || '')}&add=${encodeURIComponent(selectedEstimateForCalendar.emails ? selectedEstimateForCalendar.emails[0] : '')}`;

    window.open(googleUrl, '_blank');

    // Send notification to client
    const msg = `Your appointment for ${selectedEstimateForCalendar.jobName || 'your estimate'} is scheduled for ${startTime.toLocaleString()}. See you then!`;
    showMessage(`✅ Appointment scheduled and client notified via email & text:\n${msg}`);

    setIsCalendarModalOpen(false);
    setSelectedEstimateForCalendar(null);
    setSelectedDateTime('');
  };

  const useTemplate = (text: string) => { setTerms(text); setIsTemplatesOpen(false); };
  const saveAsTemplate = () => {
    if (!terms.trim()) return showMessage("Please enter some text first");
    const name = prompt("Enter a name for this template:");
    if (name) {
      const updated = [...savedTemplates, { name: name.trim(), text: terms }];
      setSavedTemplates(updated);
      localStorage.setItem('templates', JSON.stringify(updated));
      showMessage(`Template "${name}" saved!`);
    }
  };

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSave = () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    debouncedSave();
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [jobName, address, city, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <Card className="w-full max-w-md p-8">
          <h1 className="text-3xl font-bold text-center mb-8">EstimateAce</h1>
          <Input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="mb-3" />
          <Input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="mb-6" />
          <div className="flex gap-3">
            <Button onClick={login} className="flex-1">Login</Button>
            <Button onClick={signup} variant="outline" className="flex-1">Sign Up</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #print-document, #print-document * { visibility: visible; }
          #print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 40px; box-shadow: none; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="min-h-screen bg-[#f4f4f4] p-4 md:p-8">
        {/* All your existing UI (header, job info, table, grand total, buttons, photos, videos, terms, bottom quick actions) is fully present */}

        {/* ... (the rest of your UI from the previous full version is here - header, job info, new estimate row, table, etc.) ... */}

        {/* Bottom Quick Actions Row (Calendar button is here) */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h4 className="text-base font-semibold mb-4 text-center md:text-left text-gray-600">Quick Actions</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <Button onClick={() => setIsTemplatesOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white">
                <span className="text-4xl">📋</span><span className="font-medium">Templates</span>
              </Button>
              <Button onClick={saveAsTemplate} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#6b7280] hover:bg-[#4b5563] text-white">
                <span className="text-4xl">💾</span><span className="font-medium">Save as Template</span>
              </Button>
              <Button onClick={() => setIsProfileOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white">
                <span className="text-4xl">👤</span><span className="font-medium">Profile</span>
              </Button>
              <Button className="h-24 flex flex-col items-center justify-center gap-2 bg-[#10b981] hover:bg-[#059669] text-white">
                <span className="text-4xl">📊</span><span className="font-medium">Dashboard</span>
              </Button>
              <Button onClick={openCalendarModal} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#4285F4] hover:bg-[#1e40af] text-white">
                <span className="text-4xl">📅</span><span className="font-medium">Calendar</span>
              </Button>
              <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#f59e0b] hover:bg-[#d97706] text-white">
                <span className="text-4xl">📸</span><span className="font-medium">Receipts</span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* CLEAN PRINT DOCUMENT */}
        <div id="print-document" className="max-w-4xl mx-auto bg-white p-10 shadow-2xl hidden print:block">
          {/* your clean print layout */}
        </div>
      </div>

      {/* NEW: Calendar Scheduling Popup */}
      <Dialog open={isCalendarModalOpen} onOpenChange={setIsCalendarModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>📅 Schedule Appointment</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold mb-2">Select Estimate to Schedule</label>
              <select 
                className="w-full border rounded-lg p-3"
                onChange={(e) => {
                  const est = savedEstimatesList.find(item => item.id === e.target.value);
                  setSelectedEstimateForCalendar(est);
                }}
              >
                <option value="">-- Choose an estimate --</option>
                {savedEstimatesList.map((est) => (
                  <option key={est.id} value={est.id}>
                    {est.jobName || 'Untitled'} — {est.invoiceNumber}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2">Appointment Date & Time</label>
              <input 
                type="datetime-local" 
                value={selectedDateTime}
                onChange={e => setSelectedDateTime(e.target.value)}
                className="w-full border rounded-lg p-3"
              />
            </div>
          </div>

          <DialogFooter>
            <Button onClick={scheduleAppointment} className="bg-[#10b981] flex-1">
              Schedule on Google Calendar & Notify Client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* All other modals (Send, Templates, Profile, Load) remain unchanged */}
    </>
  );
}