import { Rocket } from 'lucide-react';

import CampaignForm from '../components/CampaignForm';
import { PageHeader } from '../components/ui/page-header';

export default function CampaignBuilder() {
  return (
    <div>
      <PageHeader
        eyebrow="Launch"
        title="New Campaign"
        description="4-step wizard — basics, ICP, sequence, review. The orchestrator will pick up the launch and start discovering prospects within seconds."
        icon={Rocket}
      />
      <CampaignForm />
    </div>
  );
}
