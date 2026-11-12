import { BASE_PATH } from '@/lib/site';

/** The supplied TotalFinance mark, shared by the homepage and documentation. */
export function TotalFinanceMark({ className }: { className?: string }) {
  return (
    <img
      src={`${BASE_PATH}/assets/brand/favicon.svg`}
      width={32}
      height={32}
      alt=""
      className={className}
    />
  );
}
