import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/password';

const prisma = new PrismaClient();

const DEFAULT_PROGRAMS = [
  {
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    name: 'Müvekkil Kasa Defteri Desktop',
    description: 'Müvekkil kasa defteri masaüstü uygulaması',
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'SIFRE_KASASI_DESKTOP',
    name: 'Şifre Kasası Desktop',
    description: 'Şifre kasası masaüstü uygulaması',
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'ISLETME_DEFTERI_DESKTOP',
    name: 'İşletme Defteri Desktop',
    description: 'İşletme defteri masaüstü uygulaması',
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'OPTIK_DESKTOP',
    name: 'Optik Programı Desktop',
    description: 'Optik programı masaüstü uygulaması',
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'BILIRKISI_DESKTOP',
    name: 'Bilirkişi Desktop',
    description: 'Bilirkişi masaüstü uygulaması',
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
];

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const passwordHash = await hashPassword(adminPassword);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: { passwordHash },
    create: {
      email: adminEmail,
      passwordHash,
      name: 'Woontegra Admin',
    },
  });

  console.log(`Admin kullanıcı hazır: ${adminEmail}`);

  for (const program of DEFAULT_PROGRAMS) {
    await prisma.program.upsert({
      where: { appCode: program.appCode },
      update: {
        name: program.name,
        description: program.description,
        defaultLicenseDays: program.defaultLicenseDays,
        defaultMaxDevices: program.defaultMaxDevices,
      },
      create: program,
    });
    console.log(`Program hazır: ${program.appCode}`);
  }

  console.log('Seed tamamlandı.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
