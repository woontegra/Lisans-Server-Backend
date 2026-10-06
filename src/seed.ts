import { PrismaClient, ProgramProductType } from '@prisma/client';
import { hashPassword } from './utils/password';
import { KOOPPLUS_PROGRAM_DEFAULTS } from './constants/desktopTrial';
import {
  APP_CODE_AKTUERYA_DESKTOP,
  APP_CODE_AKTUERYA_SAAS,
  SAAS_PRODUCT_CODE_AKTUERYA,
  SAAS_TARGET_AKTUERYA,
} from './constants/aktuerya';

const prisma = new PrismaClient();

const DEFAULT_PROGRAMS: Array<{
  appCode: string;
  name: string;
  description: string;
  productType: ProgramProductType;
  targetService: string | null;
  saasProductCode: string | null;
  defaultLicenseDays: number;
  defaultMaxDevices: number;
}> = [
  {
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    name: 'Müvekkil Kasa Defteri Desktop',
    description: 'Müvekkil kasa defteri masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'SIFRE_KASASI_DESKTOP',
    name: 'Şifre Kasası Desktop',
    description: 'Şifre kasası masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'ISLETME_DEFTERI_DESKTOP',
    name: 'İşletme Defteri Desktop',
    description: 'İşletme defteri masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'OPTIK_DESKTOP',
    name: 'Optik Programı Desktop',
    description: 'Optik programı masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'BILIRKISI_DESKTOP',
    name: 'Bilirkişi Desktop',
    description: 'Bilirkişi masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: KOOPPLUS_PROGRAM_DEFAULTS.appCode,
    name: KOOPPLUS_PROGRAM_DEFAULTS.name,
    description: KOOPPLUS_PROGRAM_DEFAULTS.description,
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: KOOPPLUS_PROGRAM_DEFAULTS.defaultLicenseDays,
    defaultMaxDevices: KOOPPLUS_PROGRAM_DEFAULTS.defaultMaxDevices,
  },
  {
    appCode: APP_CODE_AKTUERYA_DESKTOP,
    name: 'Aktüerya Hesaplama Desktop',
    description: 'Aktüerya hesaplama masaüstü uygulaması. Windows ve macOS aynı program kodunu kullanır.',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: APP_CODE_AKTUERYA_SAAS,
    name: 'Aktüerya Hesaplama SaaS',
    description: 'Aktüerya hesaplama web aboneliği. Provision henüz bağlı değildir.',
    productType: ProgramProductType.SAAS,
    targetService: SAAS_TARGET_AKTUERYA,
    saasProductCode: SAAS_PRODUCT_CODE_AKTUERYA,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
];

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error('ADMIN_EMAIL ve ADMIN_PASSWORD ortam değişkenleri gerekli');
  }

  const passwordHash = await hashPassword(adminPassword);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: { passwordHash, name: 'Woontegra Admin' },
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
        productType: program.productType,
        targetService: program.targetService,
        saasProductCode: program.saasProductCode,
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
