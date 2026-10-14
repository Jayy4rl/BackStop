// L2-7: freelancer profile with completed protected jobs and dispute record.
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorNotice, Loading, Money, When, useLoad } from '../components/ui';

export function Profile() {
  const { handle } = useParams();
  const p = useLoad(() => api.get(`/public/profiles/${handle}`), [handle]);
  if (p.error) return <ErrorNotice error={p.error} />;
  if (!p.data) return <Loading />;
  const x = p.data;
  return (
    <div className="card">
      <h1>
        {x.verifiedName ?? `@${x.handle}`} {x.verified && <span className="badge ok">Identity verified</span>}
      </h1>
      <p className="muted">
        @{x.handle} · member since <When at={x.memberSince} />
      </p>
      <dl className="kv">
        <dt>Completed protected jobs</dt>
        <dd>{x.completedProtectedJobs}</dd>
        <dt>Released through escrow</dt>
        <dd>
          <Money amount={x.releasedVolume} />
        </dd>
        <dt>Disputes</dt>
        <dd>
          {x.disputes} ({x.disputesLost} ruled against)
        </dd>
      </dl>
    </div>
  );
}
