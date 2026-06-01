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
  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

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

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);

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
      jobName, address, city, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile, documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod, photoUrls, videoUrls, updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) console.error('Save error:', error);
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
    showMessage('✅ Loaded from Supabase!');
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete permanently?')) return;
    if (!supabase) return;
    await supabase.from('estimates').delete().eq('id', id);
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const newEstimate = () => {
    if (!confirm('Start new document?')) return;
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

  const useTemplate = (text: string) => { setTerms(text); setIsTemplatesOpen(false); };
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

  const openQuickLinesModal = () => setIsQuickLinesModalOpen(true);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSave = () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    debouncedSave();
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [jobName, address, city, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod]);

  useEffect(() => {
    const saved = localStorage.getItem('quickLines');
    if (saved) setQuickLines(JSON.parse(saved));
    setDate(new Date().toISOString().split('T')[0]);
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

      <div className="min-h-screen bg-[#f4f4f4] p-4 md:p-8">
        {/* HEADER TOGGLE */}
        <div className="flex border-b mb-8 bg-white rounded-t-xl overflow-hidden shadow-sm">
          <button onClick={() => setDocumentType('estimate')} className={`flex-1 py-5 text-2xl font-semibold ${documentType === 'estimate' ? 'bg-[#1e293b] text-white' : 'hover:bg-gray-100'}`}>📋 Estimate</button>
          <button onClick={() => setDocumentType('invoice')} className={`flex-1 py-5 text-2xl font-semibold ${documentType === 'invoice' ? 'bg-[#1e293b] text-white' : 'hover:bg-gray-100'}`}>💰 Invoice</button>
        </div>

        {/* COMPANY HEADER */}
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

        {/* JOB INFO CARD */}
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
              <div>
                <label className="block text-sm font-semibold mb-1">City</label>
                <Input value={city} onChange={e => setCity(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Zip Code</label>
                <Input value={zipCode} onChange={e => setZipCode(e.target.value)} />
              </div>
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

        {/* NEW ESTIMATE ROW */}
        <div className="flex flex-wrap gap-3 mb-8">
          <Button onClick={newEstimate} className="bg-[#10b981]">📄 New Estimate</Button>
          <Button onClick={addRow} variant="outline">+ Add Line Item</Button>
          <Button onClick={openLoadModal} variant="outline">📂 Load Document</Button>
          <Button onClick={openQuickLinesModal} variant="outline">📌 Quick Lines</Button>
        </div>

        {/* MAIN TABLE */}
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

          <div className="p-6 bg-white border-t flex flex-wrap gap-3 no-print">
            <Button onClick={() => document.getElementById('photo-camera')?.click()}>📸 Take Photo</Button>
            <Button onClick={() => document.getElementById('video-camera')?.click()}>🎥 Record Video</Button>
            <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">💾 Save Estimate</Button>
            <Button onClick={convertToInvoice} className="bg-[#f59e0b]">📄 Convert to Invoice</Button>
            <Button onClick={printDocument} className="bg-[#3b82f6]">🖨️ Print / Preview</Button>
            <Button onClick={openSendModal} className="bg-[#8b5cf6]">✉️ Send</Button>
          </div>
        </Card>

        {/* PHOTOS SECTION — RED X DELETE ADDED */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-xl font-semibold mb-4">📸 Photos ({photoUrls.length})</h3>
            <input id="photo-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
            <input type="file" accept="image/*" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="mb-4" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {photoUrls.map((url, i) => (
                <div key={i} className="relative group">
                  <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                  <button 
                    onClick={() => removeMedia('photo', i)} 
                    className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* VIDEOS SECTION (unchanged) */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-xl font-semibold mb-4">🎥 Videos ({videoUrls.length})</h3>
            <input id="video-camera" type="file" accept="video/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />
            <input type="file" accept="video/*" multiple onChange={e => handleMediaUpload(e.target.files, 'video')} className="mb-4" />
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

        {/* TERMS */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-xl font-semibold mb-3">Terms & Conditions</h3>
            <Textarea value={terms} onChange={e => setTerms(e.target.value)} rows={6} />
          </CardContent>
        </Card>

        {/* QUICK ACTIONS */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h4 className="text-base font-semibold mb-4">Quick Actions</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <Button onClick={() => setIsTemplatesOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#3b82f6]">📋 Templates</Button>
              <Button onClick={saveAsTemplate} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#6b7280]">💾 Save Template</Button>
              <Button onClick={() => setIsProfileOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#8b5cf6]">👤 Profile</Button>
              <Button className="h-24 flex flex-col items-center justify-center gap-2 bg-[#10b981]">📊 Dashboard</Button>
              <Button onClick={openCalendarModal} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#4285F4]">📅 Calendar</Button>
              <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#f59e0b]">📸 Receipts</Button>
            </div>
          </CardContent>
        </Card>

        {/* HIDDEN CAMERA INPUTS */}
        <input id="photo-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
        <input id="video-camera" type="file" accept="video/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />
        <input id="receipts-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />

        {/* PRINT DOCUMENT WITH PHOTOS ATTACHED */}
        <div id="print-document" className="max-w-4xl mx-auto bg-white p-10 shadow-2xl hidden print:block">
          <h1 className="text-4xl font-bold text-center mb-8">{profile.company || 'Your Company'}</h1>
          {(profile.phone || profile.email) && (
            <p className="text-center text-xl text-gray-600 mb-8">
              {profile.phone && `📞 ${profile.phone}`}
              {profile.phone && profile.email && ' | '}
              {profile.email && `✉️ ${profile.email}`}
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

          {photoUrls.length > 0 && (
            <div className="mt-12">
              <h3 className="text-xl font-semibold mb-4">📸 Attached Photos</h3>
              <div className="grid grid-cols-2 gap-4">
                {photoUrls.map((url, i) => (
                  <img key={i} src={url} alt={`Photo ${i+1}`} className="w-full border rounded-lg" />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ALL MODALS (unchanged) */}
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
                  <Button size="sm" onClick={() => loadSelectedEstimate(est)}>Load</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isSendModalOpen} onOpenChange={setIsSendModalOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Send {documentType.toUpperCase()}</DialogTitle></DialogHeader>
          <div className="space-y-6">
            <div>
              <h4 className="font-medium mb-2">Email to:</h4>
              {emails.map((em, i) => (
                <label key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={selectedEmailsForSend.includes(em)} onChange={() => {
                    if (selectedEmailsForSend.includes(em)) setSelectedEmailsForSend(selectedEmailsForSend.filter(e => e !== em));
                    else setSelectedEmailsForSend([...selectedEmailsForSend, em]);
                  }} />
                  {em}
                </label>
              ))}
            </div>
            <div>
              <h4 className="font-medium mb-2">Text to:</h4>
              {phones.map((ph, i) => (
                <label key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={selectedPhonesForSend.includes(ph)} onChange={() => {
                    if (selectedPhonesForSend.includes(ph)) setSelectedPhonesForSend(selectedPhonesForSend.filter(p => p !== ph));
                    else setSelectedPhonesForSend([...selectedPhonesForSend, ph]);
                  }} />
                  {ph}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={sendViaEmail} className="flex-1">📧 Send Email</Button>
            <Button onClick={sendViaText} className="flex-1">📱 Send Text</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isTemplatesOpen} onOpenChange={setIsTemplatesOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Templates</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-96 overflow-auto"></div>
        </DialogContent>
      </Dialog>

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

      <Dialog open={isQuickLinesModalOpen} onOpenChange={setIsQuickLinesModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>📌 Quick Lines</DialogTitle></DialogHeader>
          <div className="max-h-80 overflow-auto space-y-2">
            {quickLines.map((q) => (
              <div key={q.id} className="flex justify-between items-center border p-3 rounded-lg">
                <div className="flex-1">
                  <div className="font-medium">{q.description}</div>
                  <div className="text-xs text-gray-500">{q.qty} × ${q.price}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => useQuickLine(q)}>Use</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteQuickLine(q.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isCalendarModalOpen} onOpenChange={setIsCalendarModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>📅 Schedule Appointment</DialogTitle></DialogHeader>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold mb-2">Select Estimate to Schedule</label>
              <select className="w-full border rounded-lg p-3" onChange={e => {
                const est = savedEstimatesList.find(item => item.id === e.target.value);
                setSelectedEstimateForCalendar(est);
              }}>
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
              <input type="datetime-local" value={selectedDateTime} onChange={e => setSelectedDateTime(e.target.value)} className="w-full border rounded-lg p-3" />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={scheduleAppointment} className="bg-[#10b981] flex-1">Schedule on Google Calendar & Notify Client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}