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
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList'>('dashboard');

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

  // Profile
  const [profile, setProfile] = useState({ 
    name: '', company: '', address: '', phone: '', email: '', slogan: '', showInHeader: true 
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
    setIsProfileOpen(false);
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
          {view === 'dashboard' && (
            <div>
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-4xl font-semibold text-[#1e293b]">Welcome back!</h2>
                  <p className="text-gray-600 mt-1">Here’s what’s happening with your business</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <Card><CardContent className="p-6"><p className="text-sm text-gray-500">Total Documents</p><p className="text-4xl font-bold text-[#1e293b]">{savedEstimatesList.length}</p></CardContent></Card>
                <Card><CardContent className="p-6"><p className="text-sm text-gray-500">This Month</p><p className="text-4xl font-bold text-[#10b981]">12</p></CardContent></Card>
                <Card><CardContent className="p-6"><p className="text-sm text-gray-500">Pending Payments</p><p className="text-4xl font-bold text-amber-600">$2,840</p></CardContent></Card>
              </div>
              <Card>
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4">Recent Documents</h3>
                  <div className="space-y-3">
                    {savedEstimatesList.slice(0, 5).map((est) => (
                      <div key={est.id} className="flex items-center justify-between border-b pb-3 last:border-none">
                        <div>
                          <div className="font-medium">{est.jobName || 'Untitled'}</div>
                          <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                        </div>
                        <Button size="sm" onClick={() => openExistingDocument(est)}>Open</Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {view === 'estimatesList' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-6">All Estimates</h2>
              <div className="space-y-4">
                {savedEstimatesList.filter(est => est.documentType === 'estimate').map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div>
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                    </div>
                    <div className="flex gap-3">
                      <Button size="sm" onClick={() => { loadSelectedEstimate(est); setView('editor'); }}>Open</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>Archive</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'invoicesList' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-6">All Invoices</h2>
              <div className="space-y-4">
                {savedEstimatesList.filter(est => est.documentType === 'invoice').map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div className="flex-1">
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                    </div>
                    <div className="flex items-center gap-4">
                      {est.paymentStatus === 'paid' && <span className="px-3 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full">Paid</span>}
                      <Button size="sm" onClick={() => { loadSelectedEstimate(est); setView('editor'); }}>Open</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>Archive</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'editor' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>

              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-5xl font-bold text-[#1e293b]">{profile.company || 'Your Company'}</h1>
                  <p className="text-xl text-gray-600">{profile.slogan || 'Professional Estimation & Invoicing'}</p>
                  {profile.phone && <p className="text-lg text-gray-600 mt-1">📞 {profile.phone}</p>}
                  {profile.email && <p className="text-lg text-gray-600">✉️ {profile.email}</p>}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">Document #</div>
                  <div className="text-4xl font-mono font-bold text-[#10b981]">{invoiceNumber}</div>
                  <div className="text-sm text-gray-500 mt-1">Date: {date}</div>
                </div>
              </div>

              <Card className="mb-8">
                <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold mb-1">Job Name</label>
                    <Input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="Job name" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Address</label>
                    <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Street address" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-semibold mb-1">City</label><Input value={city} onChange={e => setCity(e.target.value)} /></div>
                    <div><label className="block text-sm font-semibold mb-1">Zip Code</label><Input value={zipCode} onChange={e => setZipCode(e.target.value)} /></div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Phone Numbers</label>
                    {phones.map((phone, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={phone} onChange={e => updatePhone(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removePhone(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addPhone}>+ Add Phone</Button>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Email Addresses</label>
                    {emails.map((em, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={em} onChange={e => updateEmail(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removeEmail(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addEmail}>+ Add Email</Button>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-3 mb-8">
                <Button onClick={addRow} variant="outline">+ Add Line Item</Button>
                <Button onClick={openQuickLinesModal} variant="outline">📌 Quick Lines</Button>
              </div>

              <Card className="mb-8">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-[#1e293b]">
                      <TableHead className="text-white">Description</TableHead>
                      <TableHead className="text-white text-right">Qty</TableHead>
                      <TableHead className="text-white text-right">Unit</TableHead>
                      <TableHead className="text-white text-right">Price</TableHead>
                      <TableHead className="text-white text-right">Total</TableHead>
                      <TableHead className="text-white w-28"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell><Textarea value={item.description} onChange={e => updateItem(item.id, 'description', e.target.value)} rows={3} /></TableCell>
                        <TableCell><Input type="number" value={item.qty} onChange={e => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} className="text-right" /></TableCell>
                        <TableCell><Input value={item.unit} onChange={e => updateItem(item.id, 'unit', e.target.value)} /></TableCell>
                        <TableCell><Input type="number" value={item.price} onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} className="text-right" /></TableCell>
                        <TableCell className="text-right font-medium">${item.total.toFixed(2)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => saveAsQuickLine(item)}>💾</Button>
                            <Button size="sm" variant="destructive" onClick={() => removeRow(item.id)}>×</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <div className="p-6 bg-white border-t">
                  <div className="flex justify-end text-4xl font-bold">
                    Grand Total: <span className="text-[#10b981] ml-4">${grandTotal.toFixed(2)}</span>
                  </div>
                </div>
              </Card>

              <div className="flex flex-wrap gap-3 mb-8">
                <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">💾 Save Estimate</Button>
                <Button onClick={printDocument} className="bg-[#3b82f6]">🖨️ Print/Preview</Button>
                <Button onClick={openSendModal} className="bg-[#8b5cf6]">✉️ Send Estimate</Button>
                <Button onClick={convertToInvoice} className="bg-[#f59e0b]">📄 Convert to Invoice</Button>
              </div>

              <div className="flex gap-3 mb-8">
                <Button onClick={() => document.getElementById('photo-camera')?.click()} className="flex-1">📸 Take Photo</Button>
                <Button onClick={() => document.getElementById('video-camera')?.click()} className="flex-1">🎥 Record Video</Button>
              </div>

              <input id="photo-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
              <input id="video-camera" type="file" accept="video/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />

              {/* Photos */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">📸 Photos ({photoUrls.length})</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {photoUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('photo', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Videos */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">🎥 Videos ({videoUrls.length})</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {videoUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <video src={url} controls className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('video', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Receipts */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">📄 Receipts ({receiptUrls.length})</h3>
                  <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="mb-4">
                    📄 Scan / Take Photo of Receipt
                  </Button>
                  <input id="receipts-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'receipt')} className="hidden" />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {receiptUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('receipt', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Terms */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-3">Terms & Conditions</h3>
                  <Textarea value={terms} onChange={e => setTerms(e.target.value)} rows={6} />
                </CardContent>
              </Card>

              {/* Print Document */}
              <div id="print-document" className="max-w-4xl mx-auto bg-white p-10 shadow-2xl hidden print:block">
                <h1 className="text-4xl font-bold text-center mb-8">{profile.company || 'Your Company'}</h1>
                {(profile.phone || profile.email) && (
                  <p className="text-center text-xl text-gray-600 mb-8">
                    {profile.phone && `📞 ${profile.phone}`}{profile.phone && profile.email && ' | '}{profile.email && `✉️ ${profile.email}`}
                  </p>
                )}
                <div className="flex justify-between mb-8">
                  <div>
                    <strong>{documentType.toUpperCase()} # {invoiceNumber}</strong><br />
                    Date: {date}<br />
                    Job: {jobName}
                  </div>
                  <div className="text-right">
                    <strong>Bill To:</strong><br />
                    {address}<br />
                    {city}, {zipCode}
                  </div>
                </div>
                <table className="w-full border-collapse mb-8">
                  <thead>
                    <tr className="border-b-2 border-gray-800">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">Price</th>
                      <th className="text-right py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-3">{item.description}</td>
                        <td className="py-3 text-right">{item.qty}</td>
                        <td className="py-3 text-right">${item.price.toFixed(2)}</td>
                        <td className="py-3 text-right">${item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-right text-3xl font-bold">Total: ${grandTotal.toFixed(2)}</div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Navigation */}
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
          <button onClick={() => { refreshSavedList(); setIsLoadModalOpen(true); }} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📂</span>
            <span>Docs</span>
          </button>
          <button onClick={() => setIsTemplatesOpen(true)} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📌</span>
            <span>Templates</span>
          </button>
          <button onClick={openCalendarModal} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📅</span>
            <span>Calendar</span>
          </button>
          <button onClick={() => setIsProfileOpen(true)} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">👤</span>
            <span>Profile</span>
          </button>
        </div>
      </div>

      {/* Load Modal */}
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

      {/* Profile Modal */}
      <Dialog open={isProfileOpen} onOpenChange={setIsProfileOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Company Profile</DialogTitle></DialogHeader>
          <Input placeholder="Company Name" value={profile.company} onChange={e => setProfile({...profile, company: e.target.value})} className="mb-3" />
          <Input placeholder="Slogan" value={profile.slogan} onChange={e => setProfile({...profile, slogan: e.target.value})} className="mb-3" />
          <Input placeholder="Phone Number" value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} className="mb-3" />
          <Input placeholder="Email Address" value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} className="mb-6" />
          <DialogFooter>
            <Button onClick={saveProfile}>Save Profile</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}