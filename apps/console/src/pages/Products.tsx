import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Page, useAction, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Product {
  productCode: string;
  live: boolean;
  updatedAt: string;
}

export function Products() {
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ products: Product[] }>('/admin/lending/products'), []);
  const action = useAction();

  return (
    <Page title="Products">
      <p className="muted">Customers can only apply for products that are live. Only a super admin can switch them.</p>
      <ErrorBox error={error ?? action.error} />
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>State</th>
            <th>Last changed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.products.map((p) => (
            <tr key={p.productCode}>
              <td>{p.productCode.replace(/_/g, ' ')}</td>
              <td>
                <span className={`badge ${p.live ? 'good' : 'neutral'}`}>{p.live ? 'Live' : 'Off'}</span>
              </td>
              <td>{dateTime(p.updatedAt)}</td>
              <td>
                {can('super_admin') && (
                  <button
                    className={p.live ? 'secondary' : ''}
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(() => api(`/admin/lending/products/${p.productCode}/live`, { body: { live: !p.live } }))
                        .then(reload)
                    }
                  >
                    {p.live ? 'Switch off' : 'Switch on'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
