import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as sql from "@pulumi/gcp/sql";


// Get some provider-namespaced configuration values
const providerCfg = new pulumi.Config("gcp");
const gcpProject = providerCfg.require("project");
const gcpRegion = providerCfg.get("region") || "us-central1";
const config = new pulumi.Config();
const dbUser = config.requireSecret("dbUser") || "postgres";
const dbPassword = config.requireSecret("dbPassword") || "postgres";
const dbName = config.get("dbName") || "graphyy-development";
const authSecret = config.getSecret("authSecret") || "authsecret";
const targetPort = config.getNumber("targetPort") || 8080;
const githubUsername = config.require("githubUsername") || "YOUR_GITHUB_USERNAME";
const githubPassword = config.requireSecret("githubPassword") || "YOUR_GITHUB_TOKEN";
const githubEmail = config.require("githubEmail") || "YOUR_GITHUB_EMAIL";
const appLabels = { app: "graphyy" };
// Get some other configuration values or use defaults
const cfg = new pulumi.Config();
const nodesPerZone = cfg.getNumber("nodesPerZone") || 1;

// Create a new network
const gkeNetwork = new gcp.compute.Network("gke-network", {
    autoCreateSubnetworks: false,
    description: "A virtual network for your GKE cluster(s)",
});

const router = new gcp.compute.Router("router", {
    network: gkeNetwork.id,
    region: gcpRegion,
});

// Cloud NAT Gateway
const natGateway = new gcp.compute.RouterNat("nat-gateway", {
    router: router.name,
    region: gcpRegion,
    natIpAllocateOption: "AUTO_ONLY",
    sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
});

// Create a new subnet in the network created above
const gkeSubnet = new gcp.compute.Subnetwork("gke-subnet", {
    ipCidrRange: "10.128.0.0/12",
    network: gkeNetwork.id,
    privateIpGoogleAccess: true,
});

// Create a new GKE cluster
const gkeCluster = new gcp.container.Cluster("gke-cluster", {
    deletionProtection: false,
    addonsConfig: {
        dnsCacheConfig: {
            enabled: true,
        },
    },
    binaryAuthorization: {
        evaluationMode: "PROJECT_SINGLETON_POLICY_ENFORCE",
    },
    datapathProvider: "ADVANCED_DATAPATH",
    description: "A GKE cluster",
    initialNodeCount: 1,
    ipAllocationPolicy: {
        clusterIpv4CidrBlock: "/14",
        servicesIpv4CidrBlock: "/20",
    },
    location: gcpRegion,
    masterAuthorizedNetworksConfig: {
        cidrBlocks: [{
            cidrBlock: "0.0.0.0/0",
            displayName: "All networks",
        }],
    },
    network: gkeNetwork.name,
    networkingMode: "VPC_NATIVE",
    privateClusterConfig: {
        enablePrivateNodes: true,
        enablePrivateEndpoint: false,
        masterIpv4CidrBlock: "10.100.0.0/28",
    },
    removeDefaultNodePool: true,
    releaseChannel: {
        channel: "STABLE",
    },
    subnetwork: gkeSubnet.name,
    workloadIdentityConfig: {
        workloadPool: `${gcpProject}.svc.id.goog`,
    },
});

const gkeNodePoolSa = new gcp.serviceaccount.Account("gke-nodepool-sa", {
    accountId: pulumi.interpolate`${gkeCluster.name}-np-sa`,
    displayName: "GKE Nodepool Service Account",
})

const gkeNodePool = new gcp.container.NodePool("gke-nodepool", {
    cluster: gkeCluster.name,
    nodeCount: nodesPerZone,
    management: {
        autoRepair: true,
        autoUpgrade: true,
    },
    nodeConfig: {
        diskSizeGb: 200,
        diskType: "pd-standard",
        oauthScopes: [
            "https://www.googleapis.com/auth/cloud-platform",
            // "https://www.googleapis.com/auth/devstorage.read_only",
            // "https://www.googleapis.com/auth/logging.write",
            // "https://www.googleapis.com/auth/monitoring",
            // "https://www.googleapis.com/auth/service.management.readonly",
            // "https://www.googleapis.com/auth/servicecontrol",
            // "https://www.googleapis.com/auth/sqlservice.admin",
        ],
        serviceAccount: gkeNodePoolSa.email,
    },
});

// Build a Kubeconfig for accessing the cluster
const clusterKubeconfig = pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${gkeCluster.masterAuth.clusterCaCertificate}
    server: https://${gkeCluster.endpoint}
  name: ${gkeCluster.name}
contexts:
- context:
    cluster: ${gkeCluster.name}
    user: ${gkeCluster.name}
  name: ${gkeCluster.name}
current-context: ${gkeCluster.name}
kind: Config
preferences: {}
users:
- name: ${gkeCluster.name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for use with kubectl by following
        https://cloud.google.com/blog/products/containers-kubernetes/kubectl-auth-changes-in-gke
      provideClusterInfo: true
`;

const serviceNetworkingApi = new gcp.projects.Service("serviceNetworkingApi", {
    service: "servicenetworking.googleapis.com",
});

const gkeVpcPeeringRange = new gcp.compute.GlobalAddress("gke-vpc-peering-range", {
    purpose: "VPC_PEERING",
    addressType: "INTERNAL",
    prefixLength: 16,
    network: gkeNetwork.selfLink,
});

const myServiceNetworkingConnection = new gcp.servicenetworking.Connection("myServiceNetworkingConnection", {
    network: gkeNetwork.selfLink,
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [gkeVpcPeeringRange.name],
}, { dependsOn: [serviceNetworkingApi] });

// Create a Google Cloud SQL Postgres instance
const postgresInstance = new sql.DatabaseInstance("postgres-instance", {
    deletionProtection: false,
    databaseVersion: "POSTGRES_13",
    settings: {
        tier: "db-f1-micro",
        ipConfiguration: {
            ipv4Enabled: true,
            privateNetwork: myServiceNetworkingConnection.network,
            authorizedNetworks: [],
        }
    },
}, { dependsOn: [myServiceNetworkingConnection] });

// Create a database in the Postgres instance
const postgresDatabase = new sql.Database("postgres-database", {
    instance: postgresInstance.name,
    name: dbName,
});

// Create a user for the Postgres instance
const postgresUser = new sql.User("postgres-user", {
    instance: postgresInstance.name,
    name: dbUser,
    password: dbPassword,
});

// Create a Kubernetes provider instance that uses our cluster from above
const k8sProvider = new k8s.Provider("k8sProvider", {
    kubeconfig: clusterKubeconfig,
});

const dockerRegistrySecret = new k8s.core.v1.Secret("ghcr-credentials", {
    metadata: {
        name: "ghcr-credentials",
    },
    type: "kubernetes.io/dockerconfigjson",
    stringData: {
        ".dockerconfigjson": pulumi.all([githubUsername, githubPassword, githubEmail]).apply(([username, password, email]) => {
            const dockerConfig = {
                auths: {
                    "ghcr.io": {
                        username,
                        password,
                        email,
                    },
                },
            };
            return JSON.stringify(dockerConfig);
        }),
    },
}, { provider: k8sProvider });

// Deploy your Docker image
const dockerImage = new k8s.apps.v1.Deployment(appLabels.app + "-deployment", {
    spec: {
        selector: { matchLabels: appLabels },
        replicas: 3,
        template: {
            metadata: { labels: appLabels },
            spec: {
                containers: [{
                    name: appLabels.app,
                    image: "ghcr.io/dakaii/mandoo:latest",
                    ports: [{ containerPort: targetPort }],
                    env: [
                        { name: "PORT", value: targetPort.toString() },
                        { name: "AUTH_SECRET", value: authSecret },
                        { name: "POSTGRES_HOST", value: gkeVpcPeeringRange.address.apply(v => v || "") },
                        { name: "POSTGRES_USER", value: postgresUser.name.apply(v => v || "") },
                        { name: "POSTGRES_PASSWORD", value: postgresUser.password.apply(v => v || "") },
                        { name: "POSTGRES_DB", value: postgresDatabase.name.apply(v => v || "") },
                    ],
                }],
                imagePullSecrets: [{ name: dockerRegistrySecret.metadata.name }],
            },
        },
    },
}, { provider: k8sProvider });

const service = new k8s.core.v1.Service(appLabels.app + "-service", {
    metadata: {
        labels: appLabels,
    },
    spec: {
        type: "LoadBalancer",
        ports: [{
            port: 80, // The port the service will be exposed on externally
            targetPort: targetPort, // The target port on the pods to forward to
            protocol: "TCP",
        }],
        selector: appLabels, // This should match the labels of the pods you want to expose
    },
}, { provider: k8sProvider });

// Export some values for use elsewhere
export const networkName = gkeNetwork.name;
export const networkId = gkeNetwork.id;
export const clusterName = gkeCluster.name;
export const clusterId = gkeCluster.id;
export const kubeconfig = clusterKubeconfig;
export const postgresInstanceName = postgresInstance.name;
export const postgresInstanceConnectionName = postgresInstance.connectionName;
export const postgresDatabaseName = postgresDatabase.name;
export const postgresUserName = postgresUser.name;
export const addServiceName = service.metadata.name;
export const dockerImageName = dockerImage.metadata.name;
export const dockerImageId = dockerImage.metadata.uid;
export const dockerImageReplicas = dockerImage.spec.replicas;
export const dockerImageContainerName = dockerImage.spec.template.spec.containers[0].name;
export const dockerImageContainerImage = dockerImage.spec.template.spec.containers[0].image;
export const dockerImageContainerPort = dockerImage.spec.template.spec.containers[0].ports[0].containerPort;
export const dockerImageContainerEnv = dockerImage.spec.template.spec.containers[0].env;
