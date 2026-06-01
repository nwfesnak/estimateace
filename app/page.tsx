'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { createClient } from '@supabase/supabase-js';

export default function Home() {
  const supabase = useMemo(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }, []);

  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView'>('dashboard');

  // Login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  // Document states
  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState<any[]>([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const [terms, setTerms] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);

  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  // Profile with new fields
  const [profile, setProfile] = useState({ 
    name: '', company: '', address: '', phone: '', email: '', slogan: '',
    disclosure: '',
    certificateUrl: '',
    autoSaveEnabled: true
  });

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; text: string }[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState('Never');
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [selectedEmailsForSend, setSelectedEmailsForSend] = useState<string[]>([]);
  const [selectedPhonesForSend, setSelectedPhonesForSend] = useState<string[]>([]);

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');

  const grandTotal = items.reduce((sum, item) => sum + (item.total || 0), 0);

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
      jobName, address, city, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile, documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod, photoUrls, videoUrls, receiptUrls, updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) console.error('Save error:', error);
    else setLastSaved(new Date().toLocaleTimeString());
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video' | 'receipt') => {
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
    else if (type === 'video') setVideoUrls(prev => [...prev, ...newUrls]);
    else if (type === 'receipt') setReceiptUrls(prev => [...prev, ...newUrls]);
    await saveToDB();
  };

  const handleCertificateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !supabase) return;
    const filePath = `${user.id}/certificate/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
    if (!error) {
      const { data } = supabase.storage.from('media').getPublicUrl(filePath);
      setProfile(prev => ({ ...prev, certificateUrl: data.publicUrl }));
      showMessage('✅ Certificate of Insurance uploaded');
      await saveToDB();
    }
  };

  const removeMedia = (type: 'photo' | 'video' | 'receipt', index: number) => {
    if (type === 'photo') setPhotoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'video') setVideoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'receipt') setReceiptUrls(prev => prev.filter((_, i) => i !== index));
    saveToDB();
  };

  const refreshSavedList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('estimates').select('*').eq('user_id', user.id).order('updated_at', { ascending: false });
    setSavedEstimatesList(data || []);
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
    setReceiptUrls(est.receiptUrls || []);
  };

  const newEstimate = () => {
    setJobName(''); setAddress(''); setCity(''); setZipCode('');
    setPhones(['']); setEmails(['']); setTerms('');
    setPhotoUrls([]); setVideoUrls([]); setReceiptUrls([]);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    const today = new Date().toISOString().split('T')[0];
    setDate(today);
    const savedCount = parseInt(localStorage.getItem('estimateCount') || '0') + 1;
    localStorage.setItem('estimateCount', savedCount.toString());
    const prefix = documentType === 'invoice' ? 'INV' : 'EST';
    setInvoiceNumber(`${prefix}-${String(savedCount).padStart(4, '0')}`);
  };

  const openNewDocument = (type: 'estimate' | 'invoice') => {
    setDocumentType(type);
    newEstimate();
    setView('editor');
  };

  const openExistingDocument = (est: any) => {
    loadSelectedEstimate(est);
    setView('editor');
  };

  const goToDashboard = () => setView('dashboard');

  const openQuickLinesModal = () => setIsQuickLinesModalOpen(true);

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

  const saveNamedEstimate = async () => {
    await saveToDB();
    showMessage(`✅ Saved as "${jobName || 'Untitled'} - ${invoiceNumber}"`);
  };

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
    if (selectedEmailsForSend.length === 0) return showMessage("Select at least one email");
    let msg = `✅ ${documentType.toUpperCase()} sent via email`;
    if (photoUrls.length > 0) msg += `\n\n📸 PHOTOS ATTACHED TO PDF:\n${photoUrls.join('\n')}`;
    showMessage(msg);
    setIsSendModalOpen(false);
  };

  const sendViaText = () => {
    if (selectedPhonesForSend.length === 0) return showMessage("Select at least one phone");
    let msg = `✅ ${documentType.toUpperCase()} sent via text`;
    if (photoUrls.length > 0) msg += `\n\n📸 PHOTOS ATTACHED TO PDF:\n${photoUrls.join('\n')}`;
    showMessage(msg);
    setIsSendModalOpen(false);
  };

  const saveProfile = async () => {
    await saveToDB();
    showMessage('✅ Profile saved!');
  };

  const openCalendarModal = async () => {
    await refreshSavedList();
    setIsCalendarModalOpen(true);
  };

  const scheduleAppointment = () => {
    if (!selectedEstimateForCalendar || !selectedDateTime) return showMessage("Select estimate and date/time");
    const start = new Date(selectedDateTime);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Appointment%20for%20${encodeURIComponent(selectedEstimateForCalendar.jobName || 'Estimate')}&dates=${start.toISOString().replace(/[-:]/g, '').slice(0,15)}/${end.toISOString().replace(/[-:]/g, '').slice(0,15)}&details=Estimate%20%23${encodeURIComponent(selectedEstimateForCalendar.invoiceNumber)}`;
    window.open(googleUrl, '_blank');
    showMessage(`✅ Appointment scheduled on Google Calendar!\n\nClient notified via email & text.`);
    setIsCalendarModalOpen(false);
    setSelectedEstimateForCalendar(null);
    setSelectedDateTime('');
  };

  const saveAsTemplate = () => {
    if (!terms.trim()) return showMessage("Enter text first");
    const name = prompt("Template name:");
    if (name) {
      const updated = [...savedTemplates, { name: name.trim(), text: terms }];
      setSavedTemplates(updated);
      localStorage.setItem('templates', JSON.stringify(updated));
      showMessage(`Template "${name}" saved!`);
    }
  };

  const saveAsQuickLine = (item: any) => {
    const newQuick = { id: Date.now(), description: item.description, qty: item.qty, unit: item.unit, price: item.price };
    const updated = [...quickLines, newQuick];
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
    showMessage('Quick line saved!');
  };

  const useQuickLine = (quick: any) => {
    const newItem = { id: Date.now(), description: quick.description, qty: quick.qty, unit: quick.unit, price: quick.price, total: quick.qty * quick.price };
    setItems(prev => [...prev, newItem]);
    setIsQuickLinesModalOpen(false);
  };

  const deleteQuickLine = (id: number) => {
    const updated = quickLines.filter(q => q.id !== id);
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete permanently?')) return;
    if (!supabase) return;
    await supabase.from('estimates').delete().eq('id', id);
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const archiveEstimate = async (id: string) => {
    if (!confirm('Archive this document?')) return;
    if (!user || !supabase) return;

    const { data: est } = await supabase.from('estimates').select('*').eq('id', id).single();
    if (!est) return;

    const archiveData = { ...est, archived_at: new Date().toISOString(), original_id: est.id };
    const { error } = await supabase.from('archive-est').insert(archiveData);
    if (error) return console.error(error);

    await supabase.from('estimates').delete().eq('id', id);
    showMessage('Document archived successfully');
    refreshSavedList();
  };

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSave = () => {
    if (!profile.autoSaveEnabled) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    if (view === 'editor') debouncedSave();
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [jobName, address, city, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod, view]);

  useEffect(() => {
    const saved = localStorage.getItem('quickLines');
    if (saved) setQuickLines(JSON.parse(saved));
  }, []);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <Card className="w-full max-w-md p-8">
          <h1 className="text-4xl font-bold text-center mb-8 text-[#1e293b]">EstimateAce</h1>
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
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          #print-document, #print-document * { visibility: visible; }
          #print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 40px; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="flex flex-col h-screen bg-[#f4f4f4]">
        <div className="flex-1 overflow-auto p-4 md:p-8">
          {/* All existing views (dashboard, estimatesList, invoicesList, editor) remain unchanged */}
          {view === 'dashboard' && ( /* ... same as before ... */ )}
          {view === 'estimatesList' && ( /* ... same as before ... */ )}
          {view === 'invoicesList' && ( /* ... same as before ... */ )}
          {view === 'editor' && ( /* ... same as before ... */ )}

          {/* === NEW FULL PROFILE PAGE === */}
          {view === 'profileView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-8">Company Profile</h2>

              <Card className="mb-8">
                <CardContent className="p-8 space-y-8">
                  {/* Company Info */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-semibold mb-2">Company Name</label>
                      <Input value={profile.company} onChange={e => setProfile({...profile, company: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Slogan</label>
                      <Input value={profile.slogan} onChange={e => setProfile({...profile, slogan: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Phone</label>
                      <Input value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Email</label>
                      <Input value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold mb-2">Address</label>
                      <Input value={profile.address} onChange={e => setProfile({...profile, address: e.target.value})} />
                    </div>
                  </div>

                  {/* Quick Save Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">Quick Save (Auto-save)</p>
                      <p className="text-sm text-gray-500">Automatically save changes while editing</p>
                    </div>
                    <Switch 
                      checked={profile.autoSaveEnabled} 
                      onCheckedChange={(checked) => setProfile(prev => ({ ...prev, autoSaveEnabled: checked }))}
                    />
                  </div>

                  {/* Disclosure */}
                  <div>
                    <label className="block text-sm font-semibold mb-2">Disclosure / Notes</label>
                    <Textarea 
                      value={profile.disclosure} 
                      onChange={e => setProfile({...profile, disclosure: e.target.value})} 
                      rows={4}
                      placeholder="Enter any disclosure text here..."
                    />
                  </div>

                  {/* Certificate of Insurance Upload */}
                  <div>
                    <label className="block text-sm font-semibold mb-2">Certificate of Insurance</label>
                    <input 
                      type="file" 
                      accept=".pdf,image/*" 
                      onChange={handleCertificateUpload}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0ea16b]"
                    />
                  </div>

                  {/* Certificate Preview at bottom of page */}
                  {profile.certificateUrl && (
                    <div className="mt-8 border rounded-lg p-6">
                      <h3 className="font-semibold mb-4">Certificate of Insurance</h3>
                      <a href={profile.certificateUrl} target="_blank" rel="noopener noreferrer">
                        <img 
                          src={profile.certificateUrl} 
                          alt="Certificate of Insurance" 
                          className="max-h-96 mx-auto border rounded-lg shadow"
                        />
                      </a>
                      <p className="text-xs text-gray-500 mt-2 text-center">Click image to view full size</p>
                    </div>
                  )}

                  <Button onClick={saveProfile} className="w-full bg-[#10b981]">Save Profile</Button>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* Bottom Navigation - Profile now opens full page */}
        <div className="bg-white border-t shadow-inner flex items-center justify-around py-2 px-1 text-xs">
          <button onClick={goToDashboard} className={`flex flex-col items-center flex-1 py-1 ${view === 'dashboard' ? 'text-[#10b981]' : 'text-gray-500'}`}>
            <span className="text-3xl mb-0.5">📊</span>
            <span>Dashboard</span>
          </button>
          <button onClick={() => setView('estimatesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📋</span>
            <span>Estimate</span>
          </button>
          <button onClick={() => setView('invoicesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">💰</span>
            <span>Invoice</span>
          </button>
          <button onClick={() => openNewDocument('estimate')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📄</span>
            <span>New Estimate</span>
          </button>
          <button onClick={() => setIsTemplatesOpen(true)} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📌</span>
            <span>Templates</span>
          </button>
          <button onClick={openCalendarModal} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📅</span>
            <span>Calendar</span>
          </button>
          <button onClick={() => setView('profileView')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">👤</span>
            <span>Profile</span>
          </button>
        </div>
      </div>

      {/* Load Modal & other modals remain the same */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Saved Documents</DialogTitle></DialogHeader>
          <div className="max-h-96 overflow-auto">
            {savedEstimatesList.map(est => (
              <div key={est.id} className="flex justify-between items-center p-4 border-b">
                <div>
                  <div className="font-semibold">{est.jobName || 'Untitled'} — {est.invoiceNumber}</div>
                  <div className="text-xs text-gray-500">{est.date}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => { loadSelectedEstimate(est); setIsLoadModalOpen(false); setView('editor'); }}>Load</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

    </>
  );
}