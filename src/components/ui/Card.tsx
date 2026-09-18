import { forwardRef, type ReactNode } from 'react';

export const Card = forwardRef<
  HTMLDivElement,
  {
    title?: string;
    subtitle?: string;
    children: ReactNode;
    className?: string;
    actions?: ReactNode;
  }
>(function Card({ title, subtitle, children, className = '', actions }, ref) {
  return (
    <div ref={ref} className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
});
