import type { ReactNode } from 'react';
import { msg } from '../../utils/i18n';

interface Props {
  href: string;
  className?: string;
  children: ReactNode;
}

export const ExternalLink = ({ href, className, children }: Props) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
    {children}
    <span className="visually-hidden">{msg('newTabSuffix')}</span>
  </a>
);
