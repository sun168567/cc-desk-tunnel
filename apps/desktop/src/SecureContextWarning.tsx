import { useEffect, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';

export default function SecureContextWarning() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = ref.current;
    const shell = element?.closest<HTMLElement>('.shell');
    if (!element || !shell) return;
    const measure = () =>
      shell.style.setProperty(
        '--web-warning-height',
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      shell.style.removeProperty('--web-warning-height');
    };
  }, []);
  return (
    <p ref={ref} className="web-context-warning" role="note">
      <ShieldAlert aria-hidden="true" />
      当前页面未处于安全上下文，通行密钥等功能可能受限。
    </p>
  );
}
