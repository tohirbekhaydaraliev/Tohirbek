import { createPGlite, type Db } from '../src/server/db/client';
import { migrate } from '../src/server/db';
import { createBusiness } from '../src/server/context/business';
import { seedDemo } from '../src/server/demo/seed';

export async function emptyDb(): Promise<{ db: Db; businessId: string }> {
  const db = await createPGlite();
  await migrate(db);
  const b = await createBusiness(db, { name: 'Test biznes', id: 'biz_test' });
  return { db, businessId: b.id };
}

export async function demoDb(): Promise<{ db: Db; businessId: string }> {
  const db = await createPGlite();
  await migrate(db);
  const businessId = await seedDemo(db);
  return { db, businessId };
}
