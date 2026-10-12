import { useEffect, useState } from 'react';

export function MemoryModePanel() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const response = await fetch('/lg/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Status unavailable');
        const value = await response.json();
        if (mounted) setStatus(value);
      } catch { if (mounted) setStatus(null); }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const mode = status?.lg_process_alive ? status.mode : 'unavailable';
  const label = mode === 'production' ? '正式聊天 · 使用正式记忆' :
    mode === 'sandbox-copy' ? '测试聊天 · 使用记忆副本' : 'LG 连接尚未就绪';
  return <div role="status" data-lg-memory-mode={mode}
    style={{ position: 'fixed', bottom: 76, left: 16, zIndex: 30, padding: '8px 12px',
      borderRadius: 8, background: mode === 'production' ? '#edf8ef' : '#fff4db', color: '#25354b', fontSize: 13 }}>
    {label}
  </div>;
}
