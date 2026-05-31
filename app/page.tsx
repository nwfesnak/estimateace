'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createClient } from '@supabase/supabase-js';

export default function Home() {
  const supabase = useMemo(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }, []);

  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const [terms, setTerms] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);

  const [profile, setProfile] = useState({
    name: '', company: '', address: '', phone: '', email: '', slogan: '',
    showInHeader: false, showQuickLineButtons: true,
  });

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; text: string }[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState('Never');
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);

  const grandTotal = items.reduce((sum, item) => sum + (item.total || 0), 0);
  const amountDue = Math.max(grandTotal - amountPaid, 0);

  // Clean message function - removes Vercel domain prefix
  const showMessage = (message: string) => {
    const cleanMessage = message.replace(/^[^\s]*\.vercel\.app says:\s*/i, '').trim();
    alert(cleanMessage);
  };

  // Auth
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => setUser(session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => setUser(session?.user ?? null));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  const login = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) showMessage(error.message); else setShowLogin(false);
  };

  const signup = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) showMessage(error.message); else showMessage('Account created! You can now login.');
  };

  const saveToDB = async () => {
    if (!user || !supabase) return;
    const data = {
      user_id: user.id,
      jobName, address, phones, emails, date, invoiceNumber, items, terms, profile,
      documentType, dueDate, paymentStatus, amountPaid, paymentMethod,
      updated_at: new Date().toISOString(),
    };
    await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    setLastSaved(new Date().toLocaleTimeString());
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

  const handlePhotos = (e: React.ChangeEvent<HTMLInputElement>) => handleMediaUpload(e.target.files, 'photo');
  const handleVideos = (e: React.ChangeEvent<HTMLInputElement>) => handleMediaUpload(e.target.files, 'video');

  const removeMedia = (type: 'photo' | 'video', index: number) => {
    if (type === 'photo') setPhotoUrls(prev => prev.filter((_, i) => i !== index));
    else setVideoUrls(prev => prev.filter((_, i) => i !== index));
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

  const loadSelectedEstimate = async (est: any) => {
    setJobName(est.jobName || '');
    setAddress(est.address || '');
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
    setIsLoadModalOpen(false);
    showMessage('Loaded from Supabase!');
  };

  const improveWithGrok = async (id: number) => { showMessage('Grok AI improvement (demo)'); };
  const convertToInvoice = () => { showMessage('Switched to Invoice mode!'); };
  const recordPayment = () => { saveToDB(); showMessage('Payment recorded'); };
  const openGoogleCalendar = () => { window.open('https://calendar.google.com', '_blank'); };
  const addRow = () => setItems([...items, { id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const updateItem = (id: number, field: string, value: any) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, [field]: value, total: (field === 'qty' || field === 'price') ? (item.qty || 0) * (item.price || 0) : item.total } : item));
  };
  const removeRow = (id: number) => setItems(prev => prev.filter(item => item.id !== id));
  const newEstimate = () => { if (confirm('Start a completely new document?')) { setJobName(''); setAddress(''); setPhones(['']); setEmails(['']); setTerms(''); setPhotoUrls([]); setVideoUrls([]); setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]); showMessage('New document started!'); } };
  const addPhone = () => setPhones([...phones, '']);
  const removePhone = (i: number) => setPhones(phones.filter((_, idx) => idx !== i));
  const updatePhone = (i: number, value: string) => { const arr = [...phones]; arr[i] = value; setPhones(arr); };
  const addEmail = () => setEmails([...emails, '']);
  const removeEmail = (i: number) => setEmails(emails.filter((_, idx) => idx !== i));
  const updateEmail = (i: number, value: string) => { const arr = [...emails]; arr[i] = value; setEmails(arr); };
  const forceSave = async () => { await saveToDB(); };
  const saveNamedEstimate = async () => { await saveToDB(); showMessage('Saved to Supabase!'); };
  const saveProfile = async () => { await saveToDB(); setIsProfileOpen(false); };
  const printEstimate = () => window.print();
  const sendEstimate = () => showMessage(`${documentType === 'invoice' ? 'Invoice' : 'Estimate'} sent successfully!`);
  const useTemplate = (text: string) => { setTerms(text); setIsTemplatesOpen(false); };
  const saveAsTemplate = () => {
    if (!terms.trim()) return showMessage("Please enter some text first");
    const name = prompt("Enter a name for this template:");
    if (name?.trim()) {
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

  useEffect(() => { debouncedSave(); return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); }; }, [jobName, address, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod]);

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
    <div className="min-h-screen bg-[#f4f4f4] p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white border rounded-xl p-4 mb-6 flex items-center justify-between text-sm">
          <div>💾 <span className="font-medium">Last saved:</span> {lastSaved}</div>
          <Button onClick={forceSave} size="sm" variant="outline">Force Save Now</Button>
        </div>

        <div className="flex border-b mb-8 bg-white rounded-t-xl overflow-hidden shadow-sm">
          <button onClick={() => setDocumentType('estimate')} className={`flex-1 py-5 text-xl font-semibold transition-all ${documentType === 'estimate' ? 'bg-[#1e293b] text-white shadow-inner' : 'hover:bg-gray-100'}`}>📋 Estimate</button>
          <button onClick={() => setDocumentType('invoice')} className={`flex-1 py-5 text-xl font-semibold transition-all ${documentType === 'invoice' ? 'bg-[#1e293b] text-white shadow-inner' : 'hover:bg-gray-100'}`}>💰 Invoice</button>
        </div>

        <div id="estimate-content" className="bg-[#1e293b] text-white p-6 rounded-xl mb-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-4xl font-bold">{documentType === 'invoice' ? 'INVOICE' : 'EstimateAce'}</h1>
              <span className="text-slate-400">Professional {documentType === 'invoice' ? 'Invoicing' : 'Estimating'}</span>
            </div>
            {profile.showInHeader && (
              <div className="text-right text-sm max-w-xs">
                <div className="font-semibold">{profile.company || profile.name}</div>
                {profile.slogan && <div className="text-xs italic text-slate-300 mb-1">{profile.slogan}</div>}
                <div className="text-xs text-slate-300">{profile.address}</div>
                <div className="text-xs text-slate-300">{profile.phone} • {profile.email}</div>
              </div>
            )}
          </div>
        </div>

        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-semibold mb-2">Job Name / Client</label>
                <Input value={jobName} onChange={(e) => setJobName(e.target.value)} className="h-12" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Address</label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-12" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2">Date</label>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-12" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">Document #</label>
                  <Input value={invoiceNumber} className="h-12 font-mono" readOnly />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 mb-8 flex-wrap">
          <Button onClick={newEstimate} className="bg-[#6b7280]">🆕 New {documentType === 'invoice' ? 'Invoice' : 'Estimate'}</Button>
          <Button onClick={addRow} className="bg-[#10b981]">➕ Add Line Item</Button>
          <Button onClick={openLoadModal} className="bg-[#3b82f6]">🔍 Load Document</Button>
        </div>

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
                  <TableCell>
                    <Textarea value={item.description} onChange={(e) => updateItem(item.id, 'description', e.target.value)} className="min-h-[100px]" />
                  </TableCell>
                  <TableCell><Input type="number" value={item.qty} onChange={(e) => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} /></TableCell>
                  <TableCell><Input value={item.unit} onChange={(e) => updateItem(item.id, 'unit', e.target.value)} /></TableCell>
                  <TableCell><Input type="number" step="0.01" value={item.price} onChange={(e) => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} /></TableCell>
                  <TableCell className="text-right font-semibold">${(item.total || 0).toFixed(2)}</TableCell>
                  <TableCell><Button variant="destructive" size="sm" onClick={() => removeRow(item.id)}>×</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="p-6 bg-white border-t text-right">
            <div className="text-3xl font-bold">
              {documentType === 'invoice' ? 'Amount Due: ' : 'Grand Total: '}
              <span className="text-[#10b981]">${amountDue.toFixed(2)}</span>
            </div>
          </div>

          {/* Bottom toolbar */}
          <div className="p-6 bg-white border-t flex justify-between items-center gap-3 flex-wrap">
            <div className="flex gap-3">
              <Button onClick={() => document.getElementById('photo-camera')?.click()} className="bg-[#10b981]">
                📷 Take Photo
              </Button>
              <Button onClick={() => document.getElementById('video-camera')?.click()} className="bg-[#10b981]">
                📹 Record Video
              </Button>
            </div>

            <div className="flex gap-3 flex-wrap">
              <Button onClick={saveNamedEstimate} className="bg-[#10b981]">
                💾 Save {documentType === 'invoice' ? 'Invoice' : 'Estimate'}
              </Button>
              <Button onClick={sendEstimate} className="bg-[#2563eb]">
                📧 Send {documentType === 'invoice' ? 'Invoice' : 'Estimate'}
              </Button>
              <Button onClick={printEstimate} className="bg-[#10b981]">
                🖨️ Print
              </Button>
            </div>
          </div>
        </Card>

        {/* Photos */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">📸 Photos</h3>
            <input type="file" multiple accept="image/*" onChange={handlePhotos} className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0f9e6e]" />
            <input id="photo-camera" type="file" accept="image/*" capture="environment" onChange={handlePhotos} className="hidden" />
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6 mt-4">
              {photoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="photo" className="w-full h-52 object-cover rounded-xl border shadow-sm" />
                  <Button variant="destructive" size="sm" className="absolute -top-2 -right-2" onClick={() => removeMedia('photo', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Videos */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">🎥 Videos</h3>
            <input type="file" multiple accept="video/*" onChange={handleVideos} className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0f9e6e]" />
            <input id="video-camera" type="file" accept="video/*" capture="environment" onChange={handleVideos} className="hidden" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {videoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <video src={src} controls className="w-full h-32 object-cover rounded-lg border" />
                  <Button variant="destructive" size="sm" className="absolute -top-2 -right-2" onClick={() => removeMedia('video', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Disclosures + Quick Actions (now fully restored) */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">Disclosures and Standard Contractor Terms</h3>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} className="min-h-[180px] mb-8" />

            <h4 className="text-base font-semibold mb-4 text-center md:text-left text-gray-600">Quick Actions</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <Button onClick={() => setIsTemplatesOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white">
                <span className="text-4xl">📋</span>
                <span className="font-medium">Templates</span>
              </Button>

              <Button onClick={saveAsTemplate} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#6b7280] hover:bg-[#4b5563] text-white">
                <span className="text-4xl">💾</span>
                <span className="font-medium">Save as Template</span>
              </Button>

              <Button onClick={() => setIsProfileOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white">
                <span className="text-4xl">👤</span>
                <span className="font-medium">Profile</span>
              </Button>

              <Button className="h-24 flex flex-col items-center justify-center gap-2 bg-[#10b981] hover:bg-[#059669] text-white">
                <span className="text-4xl">📊</span>
                <span className="font-medium">Dashboard</span>
              </Button>

              <Button onClick={openGoogleCalendar} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#4285F4] hover:bg-[#1e40af] text-white">
                <span className="text-4xl">📅</span>
                <span className="font-medium">Calendar</span>
              </Button>

              <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#f59e0b] hover:bg-[#d97706] text-white">
                <span className="text-4xl">📸</span>
                <span className="font-medium">Receipts</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <input id="receipts-camera" type="file" accept="image/*" capture="environment" onChange={handleMediaUpload} className="hidden" />

      {/* Load Modal */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader><DialogTitle>🔍 Load Saved Document</DialogTitle></DialogHeader>
          <div className="max-h-[500px] overflow-y-auto">
            {savedEstimatesList.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No saved documents yet.</p>
            ) : (
              savedEstimatesList.map((est) => (
                <div key={est.id} className="flex justify-between p-4 border rounded-lg mb-2">
                  <div className="font-semibold">{est.invoiceNumber} — {est.jobName}</div>
                  <Button size="sm" onClick={() => loadSelectedEstimate(est)}>Load</Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Profile Modal */}
      <Dialog open={isProfileOpen} onOpenChange={setIsProfileOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>👤 Company Profile</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><label className="block text-sm font-semibold mb-1">Name</label><Input value={profile.name} onChange={(e) => setProfile({...profile, name: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Company Name</label><Input value={profile.company} onChange={(e) => setProfile({...profile, company: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Address</label><Input value={profile.address} onChange={(e) => setProfile({...profile, address: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Phone</label><Input value={profile.phone} onChange={(e) => setProfile({...profile, phone: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Email</label><Input value={profile.email} onChange={(e) => setProfile({...profile, email: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Slogan</label><Input value={profile.slogan} onChange={(e) => setProfile({...profile, slogan: e.target.value})} /></div>
          </div>
          <DialogFooter>
            <Button onClick={saveProfile} className="bg-[#10b981]">Save Profile</Button>
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
    </div>
  );
}