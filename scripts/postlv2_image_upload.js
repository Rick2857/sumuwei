import { useState } from 'react';

// Keep selected originals until the existing text-input path submits the turn.
export function useImageUpload() {
  const [images, setImages] = useState([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const clear = () => { setImages([]); setError(''); };
  const onChange = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setReading(true);
    setError('');
    try {
      if (files.length > 4 || files.some(file => file.size > 8 * 1024 * 1024)
          || files.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024
          || files.some(file => !['image/png', 'image/jpeg'].includes(file.type))) {
        throw new Error('请选择 PNG/JPEG 图片：最多 4 张，每张 8 MiB、合计 16 MiB。');
      }
      const selected = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
        reader.onload = () => resolve({ source: 'upload', data: reader.result, mime_type: file.type });
        reader.readAsDataURL(file);
      })));
      setImages(selected);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setReading(false);
    }
  };
  return { images, reading, error, clear, onChange };
}
