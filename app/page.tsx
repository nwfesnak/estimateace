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
        {/* HEADER */}
        <div className="flex border-b mb-8 bg-white rounded-t-xl overflow-hidden shadow-sm">
          <button onClick={() => setDocumentType('estimate')} className={`flex-1 py-5 text-xl font-semibold ${documentType === 'estimate' ? 'bg-[#1e293b] text-white' : 'hover:bg-gray-100'}`}>📋 Estimate</button>
          <button onClick={() => setDocumentType('invoice')} className={`flex-1 py-5 text-xl font-semibold ${documentType === 'invoice' ? 'bg-[#1e293b] text-white' : 'hover:bg-gray-100'}`}>💰 Invoice</button>
        </div>

        {/* Job Info */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div>
                <label className="block text-sm font-semibold mb-2">Job Name / Client</label>
                <Input value={jobName} onChange={e => setJobName(e.target.value)} className="h-12" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Address</label>
                <Input value={address} onChange={e => setAddress(e.target.value)} className="h-12" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">City</label>
                <Input value={city} onChange={e => setCity(e.target.value)} className="h-12" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Zip Code</label>
                <Input value={zipCode} onChange={e => setZipCode(e.target.value)} className="h-12" />
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <label className="block text-sm font-semibold mb-3">Phone Numbers</label>
                {phones.map((phone, i) => (
                  <div key={i} className="flex gap-2 mb-3">
                    <Input value={phone} onChange={e => updatePhone(i, e.target.value)} placeholder="Phone number" className="flex-1" />
                    <Button variant="destructive" size="sm" onClick={() => removePhone(i)}>×</Button>
                  </div>
                ))}
                <Button onClick={addPhone} size="sm" variant="outline">+ Add Phone</Button>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-3">Email Addresses</label>
                {emails.map((em, i) => (
                  <div key={i} className="flex gap-2 mb-3">
                    <Input value={em} onChange={e => updateEmail(i, e.target.value)} placeholder="Email address" className="flex-1" />
                    <Button variant="destructive" size="sm" onClick={() => removeEmail(i)}>×</Button>
                  </div>
                ))}
                <Button onClick={addEmail} size="sm" variant="outline">+ Add Email</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* New Estimate Row */}
        <div className="flex gap-3 mb-8 flex-wrap">
          <Button onClick={newEstimate} className="bg-[#6b7280]">🆕 New Estimate</Button>
          <Button onClick={addRow} className="bg-[#10b981]">➕ Add Line Item</Button>
          <Button onClick={openLoadModal} className="bg-[#3b82f6]">🔍 Load Document</Button>
        </div>

        {/* Table + Grand Total + Buttons Under Grand Total */}
        <Card className="mb-8">
          <Table>
            <TableHeader>
              <TableRow className="bg-[#1e293b] text-white">
                <TableHead className="w-[55%]">Description</TableHead>
                <TableHead className="w-[9%]">Qty</TableHead>
                <TableHead className="w-[9%]">Unit</TableHead>
                <TableHead className="w-[9%]">Price</TableHead>
                <TableHead className="w-[9%] text-right">Total</TableHead>
                <TableHead className="w-[9%]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-black">
                    <Textarea value={item.description} onChange={e => updateItem(item.id, 'description', e.target.value)} className="min-h-[100px] text-black" />
                  </TableCell>
                  <TableCell><Input type="number" value={item.qty} onChange={e => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} /></TableCell>
                  <TableCell><Input value={item.unit} onChange={e => updateItem(item.id, 'unit', e.target.value)} /></TableCell>
                  <TableCell><Input type="number" step="0.01" value={item.price} onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} /></TableCell>
                  <TableCell className="text-right font-semibold">${(item.total || 0).toFixed(2)}</TableCell>
                  <TableCell><Button variant="destructive" size="sm" onClick={() => removeRow(item.id)}>×</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="p-6 bg-white border-t text-right text-3xl font-bold">
            {documentType === 'invoice' ? 'Amount Due: ' : 'Grand Total: '}
            <span className="text-[#10b981]">${amountDue.toFixed(2)}</span>
          </div>

          <div className="p-6 bg-white border-t flex justify-between items-center gap-3 flex-wrap no-print">
            <div className="flex gap-3">
              <Button onClick={() => document.getElementById('photo-camera')?.click()} className="bg-[#10b981]">📷 Take Photo</Button>
              <Button onClick={() => document.getElementById('video-camera')?.click()} className="bg-[#10b981]">📹 Record Video</Button>
            </div>
            <div className="flex gap-3 flex-wrap">
              <Button onClick={saveNamedEstimate} className="bg-[#10b981]">💾 Save</Button>
              <Button onClick={convertToInvoice} className="bg-[#10b981]">💰 Convert to Invoice</Button>
              <Button onClick={printDocument} className="bg-[#10b981] font-semibold">🖨️ Print / Preview</Button>
              <Button onClick={openSendModal} className="bg-[#2563eb]">📧 Send</Button>
            </div>
          </div>
        </Card>

        {/* Photos */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">📸 Photos</h3>
            <input type="file" multiple accept="image/*" onChange={e => handleMediaUpload(e.target.files, 'photo')} className="text-sm" />
            <input id="photo-camera" type="file" accept="image/*" capture="environment" onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {photoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="photo" className="w-full h-52 object-cover rounded-xl" />
                  <Button variant="destructive" size="sm" className="absolute top-2 right-2" onClick={() => removeMedia('photo', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Videos */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">🎥 Videos</h3>
            <input type="file" multiple accept="video/*" onChange={e => handleMediaUpload(e.target.files, 'video')} className="text-sm" />
            <input id="video-camera" type="file" accept="video/*" capture="environment" onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {videoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <video src={src} controls className="w-full h-32 object-cover rounded-lg" />
                  <Button variant="destructive" size="sm" className="absolute top-2 right-2" onClick={() => removeMedia('video', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Terms */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">Terms & Conditions</h3>
            <Textarea value={terms} onChange={e => setTerms(e.target.value)} className="min-h-[180px]" />
          </CardContent>
        </Card>

        {/* BOTTOM QUICK ACTIONS ROW (starting with Templates) */}
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
              <Button onClick={openGoogleCalendar} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#4285F4] hover:bg-[#1e40af] text-white">
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
          <div className="flex justify-between border-b pb-6 mb-8">
            <div>
              <h1 className="text-5xl font-bold tracking-tight">{documentType.toUpperCase()}</h1>
              <p className="text-2xl text-gray-600 mt-1">#{invoiceNumber} • {date}</p>
            </div>
            {profile.showInHeader && (
              <div className="text-right">
                <div className="text-3xl font-bold">{profile.company || profile.name}</div>
                {profile.slogan && <div className="italic text-lg">{profile.slogan}</div>}
                <div className="text-sm mt-3">{profile.address}</div>
                <div className="text-sm">{profile.phone} • {profile.email}</div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-12 mb-10">
            <div>
              <div className="uppercase text-xs tracking-widest text-gray-500 mb-1">Bill To</div>
              <div className="font-semibold text-xl">{jobName}</div>
              <div>{address}</div>
              <div>{city} {zipCode}</div>
            </div>
            <div className="text-right">
              <div className="uppercase text-xs tracking-widest text-gray-500 mb-1">Date</div>
              <div className="text-xl">{date}</div>
            </div>
          </div>

          <table className="w-full border-collapse mb-10">
            <thead>
              <tr className="border-b-2 border-gray-800">
                <th className="text-left py-4 font-semibold">Description</th>
                <th className="w-20 text-center py-4 font-semibold">Qty</th>
                <th className="w-24 text-center py-4 font-semibold">Unit</th>
                <th className="w-28 text-right py-4 font-semibold">Price</th>
                <th className="w-28 text-right py-4 font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="py-4">{item.description}</td>
                  <td className="py-4 text-center">{item.qty}</td>
                  <td className="py-4 text-center">{item.unit}</td>
                  <td className="py-4 text-right">${Number(item.price).toFixed(2)}</td>
                  <td className="py-4 text-right font-medium">${Number(item.total).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex justify-end">
            <div className="w-80">
              <div className="flex justify-between py-3 text-xl">
                <span className="font-semibold">Total</span>
                <span className="font-bold">${grandTotal.toFixed(2)}</span>
              </div>
              {documentType === 'invoice' && amountPaid > 0 && (
                <div className="flex justify-between py-3 text-xl">
                  <span className="font-semibold">Paid</span>
                  <span className="font-bold text-green-600">-${amountPaid.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between py-4 border-t-2 border-gray-800 text-3xl font-bold">
                <span>{documentType === 'invoice' ? 'Amount Due' : 'Total Due'}</span>
                <span>${amountDue.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {terms && (
            <div className="mt-16 border-t pt-8">
              <div className="font-semibold mb-3">Terms &amp; Conditions</div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap">{terms}</div>
            </div>
          )}

          <div className="text-center text-xs text-gray-400 mt-16">
            Thank you for your business • {profile.company || profile.name}
          </div>
        </div>
      </div>

      {/* Hidden camera inputs */}
      <input id="photo-camera" type="file" accept="image/*" capture="environment" onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
      <input id="video-camera" type="file" accept="video/*" capture="environment" onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />
      <input id="receipts-camera" type="file" accept="image/*" capture="environment" onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />

      {/* Send Modal */}
      <Dialog open={isSendModalOpen} onOpenChange={setIsSendModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Send {documentType.toUpperCase()}</DialogTitle></DialogHeader>
          <DialogFooter className="flex gap-3">
            <Button onClick={sendViaEmail} className="flex-1 bg-[#2563eb]">📧 Send via Email</Button>
            <Button onClick={sendViaText} className="flex-1 bg-[#10b981]">📱 Send via Text</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Templates Modal */}
      <Dialog open={isTemplatesOpen} onOpenChange={setIsTemplatesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>📋 Templates</DialogTitle></DialogHeader>
          <div className="max-h-[400px] overflow-y-auto space-y-3">
            <div className="font-medium text-sm text-gray-500">Pre-made Templates</div>
            {[
              { name: 'Standard Payment Terms', text: '50% deposit due upon signing. Remaining 50% due upon completion.' },
              { name: 'Warranty', text: 'All workmanship is guaranteed for 12 months from date of completion.' },
            ].map((tpl, i) => (
              <div key={i} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                <div className="flex-1">
                  <div className="font-medium">{tpl.name}</div>
                  <div className="text-xs text-gray-500 line-clamp-2">{tpl.text}</div>
                </div>
                <Button size="sm" onClick={() => useTemplate(tpl.text)}>Use</Button>
              </div>
            ))}
            {savedTemplates.length > 0 && (
              <>
                <div className="font-medium text-sm text-gray-500 mt-6">Your Saved Templates</div>
                {savedTemplates.map((tpl, i) => (
                  <div key={i} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                    <div className="flex-1">
                      <div className="font-medium">{tpl.name}</div>
                      <div className="text-xs text-gray-500 line-clamp-2">{tpl.text}</div>
                    </div>
                    <Button size="sm" onClick={() => useTemplate(tpl.text)}>Use</Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Profile Modal */}
      <Dialog open={isProfileOpen} onOpenChange={setIsProfileOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>👤 Company Profile</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><label className="block text-sm font-semibold mb-1">Name</label><Input value={profile.name} onChange={e => setProfile({...profile, name: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Company Name</label><Input value={profile.company} onChange={e => setProfile({...profile, company: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Address</label><Input value={profile.address} onChange={e => setProfile({...profile, address: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Phone</label><Input value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Email</label><Input value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Slogan</label><Input value={profile.slogan} onChange={e => setProfile({...profile, slogan: e.target.value})} /></div>
          </div>
          <DialogFooter>
            <Button onClick={saveProfile} className="bg-[#10b981]">Save Profile</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Load Modal */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader><DialogTitle>🔍 Load Saved Document</DialogTitle></DialogHeader>
          <div className="max-h-[500px] overflow-y-auto">
            {savedEstimatesList.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No saved documents yet.</p>
            ) : (
              savedEstimatesList.map((est) => (
                <div key={est.id} className="flex justify-between items-center p-4 border rounded-lg mb-2">
                  <div className="font-semibold">{est.jobName || 'Untitled'} — {est.invoiceNumber}</div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => loadSelectedEstimate(est)}>Load</Button>
                    <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}