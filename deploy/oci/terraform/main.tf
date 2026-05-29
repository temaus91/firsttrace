locals {
  compartment_id = var.compartment_ocid
  common_tags = {
    managed-by = "terraform"
    product    = "firsttrace"
  }

  runtime_enabled = trimspace(var.container_image_url) != ""
  runtime_env = {
    FIRSTTRACE_AI_PROVIDER                   = var.ai_provider
    FIRSTTRACE_CONFIG_PATH                    = var.config_path
    FIRSTTRACE_MODEL_CHAT                     = var.ai_model
    FIRSTTRACE_QUEUE_PROVIDER                 = "oci"
    FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER = "false"
    FIRSTTRACE_WORKER_IDLE_DELAY_MS           = "1000"
    OCI_COMPARTMENT_ID                        = local.compartment_id
    OCI_GENAI_DEDICATED_ENDPOINT_ID           = var.oci_genai_dedicated_endpoint_id
    OCI_OBJECTSTORAGE_BUCKET                  = oci_objectstorage_bucket.state.name
    OCI_OBJECTSTORAGE_NAMESPACE               = data.oci_objectstorage_namespace.current.namespace
    OCI_QUEUE_ID                              = oci_queue_queue.jobs.id
    OCI_QUEUE_MESSAGES_ENDPOINT               = oci_queue_queue.jobs.messages_endpoint
    OCI_QUEUE_POLL_TIMEOUT_SECONDS            = tostring(var.queue_poll_timeout_seconds)
    OCI_QUEUE_VISIBILITY_TIMEOUT_SECONDS      = tostring(var.queue_visibility_seconds)
    OCI_REGION                                = var.region
    OCI_VAULT_ID                              = oci_kms_vault.secrets.id
    OCI_VAULT_SECRET_NAMES                    = var.runtime_secret_names
  }
}

data "oci_identity_availability_domains" "current" {
  compartment_id = var.tenancy_ocid
}

data "oci_objectstorage_namespace" "current" {
  compartment_id = var.tenancy_ocid
}

resource "oci_core_vcn" "runtime" {
  cidr_block     = var.vcn_cidr
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-runtime-vcn"
  dns_label      = "firsttrace"
  freeform_tags  = local.common_tags
}

resource "oci_core_internet_gateway" "runtime" {
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-internet-gateway"
  enabled        = true
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.runtime.id
}

resource "oci_core_route_table" "runtime" {
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-route-table"
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.runtime.id

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.runtime.id
  }
}

resource "oci_core_security_list" "runtime" {
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-security-list"
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.runtime.id

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = var.subnet_cidr

    tcp_options {
      min = 8080
      max = 8080
    }
  }

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
}

resource "oci_core_subnet" "runtime" {
  cidr_block                 = var.subnet_cidr
  compartment_id             = local.compartment_id
  display_name               = "${var.project_name}-runtime-subnet"
  dns_label                  = "runtime"
  freeform_tags              = local.common_tags
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.runtime.id
  security_list_ids          = [oci_core_security_list.runtime.id]
  vcn_id                     = oci_core_vcn.runtime.id
}

resource "oci_queue_queue" "jobs" {
  compartment_id                   = local.compartment_id
  display_name                     = "${var.project_name}-jobs"
  freeform_tags                    = local.common_tags
  retention_in_seconds             = var.queue_retention_seconds
  timeout_in_seconds               = var.queue_poll_timeout_seconds
  visibility_in_seconds            = var.queue_visibility_seconds
  dead_letter_queue_delivery_count = 5
}

resource "oci_objectstorage_bucket" "state" {
  compartment_id = local.compartment_id
  name           = "${var.project_name}-state"
  namespace      = data.oci_objectstorage_namespace.current.namespace
  freeform_tags  = local.common_tags
}

resource "oci_kms_vault" "secrets" {
  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-vault"
  freeform_tags  = local.common_tags
  vault_type     = "DEFAULT"
}

resource "oci_kms_key" "secrets" {
  compartment_id      = local.compartment_id
  display_name        = "${var.project_name}-secret-key"
  freeform_tags       = local.common_tags
  management_endpoint = oci_kms_vault.secrets.management_endpoint

  key_shape {
    algorithm = "AES"
    length    = 32
  }
}

resource "oci_artifacts_container_repository" "image" {
  compartment_id = local.compartment_id
  display_name   = var.project_name
  freeform_tags  = local.common_tags
  is_immutable   = false
  is_public      = true
}

resource "oci_identity_dynamic_group" "runtime" {
  compartment_id = var.tenancy_ocid
  description    = "FirstTrace runtime container instances."
  matching_rule  = "ALL {resource.type='computecontainerinstance', resource.compartment.id='${local.compartment_id}'}"
  name           = "${var.project_name}-runtime-containers"
}

resource "oci_identity_policy" "runtime" {
  compartment_id = local.compartment_id
  description    = "Allow FirstTrace runtime containers to use Queue, Object Storage, and Vault secrets."
  name           = "${var.project_name}-runtime-policy"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.runtime.name} to use queues in compartment id ${local.compartment_id} where target.queue.id='${oci_queue_queue.jobs.id}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.runtime.name} to read buckets in compartment id ${local.compartment_id} where target.bucket.name='${oci_objectstorage_bucket.state.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.runtime.name} to manage objects in compartment id ${local.compartment_id} where target.bucket.name='${oci_objectstorage_bucket.state.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.runtime.name} to read secret-bundles in compartment id ${local.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.runtime.name} to use generative-ai-family in compartment id ${local.compartment_id}",
  ]
}

resource "oci_container_instances_container_instance" "runtime" {
  count = local.runtime_enabled ? 1 : 0

  availability_domain      = data.oci_identity_availability_domains.current.availability_domains[0].name
  compartment_id           = local.compartment_id
  container_restart_policy = "ALWAYS"
  display_name             = "${var.project_name}-runtime"
  freeform_tags            = local.common_tags
  shape                    = var.shape

  shape_config {
    memory_in_gbs = var.memory_gbs
    ocpus         = var.ocpus
  }

  containers {
    arguments             = []
    command               = ["firsttrace-http"]
    display_name          = "receiver"
    environment_variables = merge(local.runtime_env, { PORT = "8080" })
    image_url             = var.container_image_url
  }

  containers {
    arguments             = []
    command               = ["firsttrace-worker"]
    display_name          = "worker"
    environment_variables = local.runtime_env
    image_url             = var.container_image_url
  }

  vnics {
    display_name           = "${var.project_name}-runtime-vnic"
    is_public_ip_assigned  = true
    subnet_id              = oci_core_subnet.runtime.id
    skip_source_dest_check = true
  }

  depends_on = [oci_identity_policy.runtime]
}

resource "oci_apigateway_gateway" "runtime" {
  count = local.runtime_enabled ? 1 : 0

  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-gateway"
  endpoint_type  = "PUBLIC"
  freeform_tags  = local.common_tags
  subnet_id      = oci_core_subnet.runtime.id
}

resource "oci_apigateway_deployment" "runtime" {
  count = local.runtime_enabled ? 1 : 0

  compartment_id = local.compartment_id
  display_name   = "${var.project_name}-api"
  gateway_id     = oci_apigateway_gateway.runtime[0].id
  path_prefix    = "/"
  freeform_tags  = local.common_tags

  specification {
    routes {
      path    = "/healthz"
      methods = ["GET"]
      backend {
        type = "HTTP_BACKEND"
        url  = "http://${oci_container_instances_container_instance.runtime[0].vnics[0].private_ip}:8080/healthz"
      }
    }

    routes {
      path    = "/api/slack/events"
      methods = ["POST"]
      backend {
        type = "HTTP_BACKEND"
        url  = "http://${oci_container_instances_container_instance.runtime[0].vnics[0].private_ip}:8080/api/slack/events"
      }
    }

    routes {
      path    = "/api/investigations"
      methods = ["POST"]
      backend {
        type = "HTTP_BACKEND"
        url  = "http://${oci_container_instances_container_instance.runtime[0].vnics[0].private_ip}:8080/api/investigations"
      }
    }

    routes {
      path    = "/api/jobs"
      methods = ["GET"]
      backend {
        type = "HTTP_BACKEND"
        url  = "http://${oci_container_instances_container_instance.runtime[0].vnics[0].private_ip}:8080/api/jobs"
      }
    }

    routes {
      path    = "/api/worker/run-once"
      methods = ["GET", "POST"]
      backend {
        type = "HTTP_BACKEND"
        url  = "http://${oci_container_instances_container_instance.runtime[0].vnics[0].private_ip}:8080/api/worker/run-once"
      }
    }
  }
}
